/**
 * Browser realtime transport.
 *
 * One connection per tab, shared by every conversation the user has open.
 *
 * Transport preference:
 *  1. **WebSocket** at `/api/v1/ws` (the standalone server, `npm run serve`,
 *     mounts it next to Next.js). Authenticated by the httpOnly `mt_session`
 *     cookie, which the browser attaches to same-origin upgrades automatically.
 *  2. **Server-Sent Events** per conversation when WebSocket is unavailable —
 *     `next dev` / `next start` do not handle upgrade requests, and some
 *     proxies strip them.
 *
 * Guarantees the rest of the app can rely on:
 *  - `connect()` is idempotent and never throws; a transport failure is reported
 *    through the status callback, **never** propagated to whatever triggered it.
 *    Signing up, sending a message or writing to PostgreSQL is never rolled back
 *    because a socket did not come up.
 *  - reconnects use exponential backoff with jitter, and every reconnect sends
 *    the last seen event id so the server replays what was missed;
 *  - callers subscribe per conversation and get a dispose function; unsubscribing
 *    removes every handler for that conversation.
 */
import { connectEventStream } from './sse-client';

export type RealtimeStatus = 'idle' | 'connecting' | 'websocket' | 'sse' | 'offline';

export interface RealtimeEventFrame {
  id?: string;
  topic: string;
  type: string;
  payload: unknown;
}

export type RealtimeHandler = (event: RealtimeEventFrame) => void;

export interface RealtimeClient {
  connect(): void;
  disconnect(): void;
  /** Subscribes to a conversation; returns an unsubscribe function. */
  subscribeConversation(conversationId: string, handler: RealtimeHandler): () => void;
  /** Asks the server to stop sending events for a conversation. */
  unsubscribeConversation(conversationId: string): void;
  onStatus(callback: (status: RealtimeStatus, detail?: string) => void): () => void;
  getStatus(): RealtimeStatus;
  /** Last outbox event id seen — used as the reconnect cursor. */
  getLastEventId(): string | null;
  /** Ephemeral typing signal (never persisted). */
  sendTyping(conversationId: string, isTyping: boolean): void;
}

/**
 * WebSocket readyState values. These are fixed by the WHATWG WebSocket spec, so
 * they are spelled out rather than read off the global's statics: an engine (or
 * a test double) that omits `WebSocket.OPEN` would otherwise make every
 * "is the socket usable?" check false and silently disable the transport.
 */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
/** After this many consecutive socket failures, prefer SSE for a while. */
const WS_FAILURES_BEFORE_FALLBACK = 2;

interface Subscription {
  conversationId: string;
  handlers: Set<RealtimeHandler>;
  sseDisconnect?: () => void;
}

function wsUrl(): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/v1/ws`;
}

export function createRealtimeClient(): RealtimeClient {
  const subscriptions = new Map<string, Subscription>();
  const statusListeners = new Set<(status: RealtimeStatus, detail?: string) => void>();
  let socket: WebSocket | null = null;
  let status: RealtimeStatus = 'idle';
  let attempt = 0;
  let failures = 0;
  let lastEventId: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let intentionallyClosed = false;
  let preferSse = false;

  function setStatus(next: RealtimeStatus, detail?: string) {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(next, detail);
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function dispatch(frame: RealtimeEventFrame) {
    if (frame.id && (!lastEventId || frame.id > lastEventId)) lastEventId = frame.id;
    const conversationId = conversationOf(frame);
    if (!conversationId) return;
    const subscription = subscriptions.get(conversationId);
    if (!subscription) return;
    for (const handler of subscription.handlers) {
      try {
        handler(frame);
      } catch {
        // A broken subscriber must not kill the transport.
      }
    }
  }

  function conversationOf(frame: RealtimeEventFrame): string | null {
    const payload = frame.payload as { conversationId?: unknown } | null;
    if (payload && typeof payload.conversationId === 'string') return payload.conversationId;
    const topic = frame.topic ?? '';
    const match = /^conversation:([^:]+)/.exec(topic);
    return match?.[1] ?? null;
  }

  function subscribeFrame() {
    return {
      type: 'subscribe',
      conversations: Array.from(subscriptions.keys()),
      ...(lastEventId ? { since: lastEventId } : {}),
    };
  }

  function openSocket() {
    if (typeof WebSocket === 'undefined') {
      switchToSse('websocket unavailable');
      return;
    }
    setStatus('connecting');
    let opened = false;
    let next: WebSocket;
    try {
      next = new WebSocket(wsUrl());
    } catch (error) {
      switchToSse(`websocket constructor failed: ${String(error)}`);
      return;
    }
    socket = next;

    next.onopen = () => {
      opened = true;
      failures = 0;
      attempt = 0;
      preferSse = false;
      setStatus('websocket');
      try {
        next.send(JSON.stringify(subscribeFrame()));
      } catch {
        /* the reconnect path will resubscribe */
      }
      heartbeat = setInterval(() => {
        try {
          if (next.readyState === WS_OPEN) next.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
    };

    next.onmessage = (event: MessageEvent) => {
      let frame: RealtimeEventFrame;
      try {
        frame = JSON.parse(String(event.data)) as RealtimeEventFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      if (frame.topic === 'system') {
        // `subscribed` carries the server's cursor; keep it so the next
        // reconnect asks for exactly what is missing.
        if (frame.type === 'subscribed') {
          const payload = frame.payload as { lastEventId?: string | null } | null;
          if (payload?.lastEventId) lastEventId = payload.lastEventId;
        }
        return;
      }
      dispatch(frame);
    };

    const onDown = (detail: string) => {
      clearTimers();
      socket = null;
      failures += 1;
      if (intentionallyClosed) {
        setStatus('idle');
        return;
      }
      if (!opened || failures >= WS_FAILURES_BEFORE_FALLBACK) {
        // Never opened (upgrade refused / proxy stripped it) or repeatedly
        // failing: serve events over SSE while still retrying the socket.
        switchToSse(detail);
      } else {
        setStatus('offline', detail);
      }
      scheduleReconnect();
    };

    next.onerror = () => onDown('websocket error');
    next.onclose = () => onDown('websocket closed');
  }

  function scheduleReconnect() {
    if (intentionallyClosed || reconnectTimer) return;
    attempt += 1;
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(attempt - 1, 5), MAX_BACKOFF_MS);
    const jitter = Math.random() * 250;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (intentionallyClosed) return;
      openSocket();
    }, backoff + jitter);
  }

  function switchToSse(detail: string) {
    preferSse = true;
    setStatus('sse', detail);
    for (const subscription of subscriptions.values()) openSseFor(subscription);
  }

  function openSseFor(subscription: Subscription) {
    if (subscription.sseDisconnect) return;
    const { conversationId, handlers } = subscription;
    subscription.sseDisconnect = connectEventStream({
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/events`,
      // The SSE route names frames after the event type, so map them back into
      // the same shape the WebSocket delivers.
      events: Object.fromEntries(
        SSE_EVENT_TYPES.map((type) => [
          type,
          (payload: unknown) => dispatch({ topic: `conversation:${conversationId}`, type, payload }),
        ]),
      ),
      onError: () => setStatus('offline', 'event stream error'),
      onReady: () => {
        if (status !== 'websocket') setStatus('sse');
      },
    });
    void handlers;
  }

  function closeSseFor(subscription: Subscription) {
    subscription.sseDisconnect?.();
    subscription.sseDisconnect = undefined;
  }

  function resubscribe() {
    if (socket && socket.readyState === WS_OPEN) {
      try {
        socket.send(JSON.stringify(subscribeFrame()));
      } catch {
        /* ignore */
      }
    }
  }

  return {
    connect() {
      intentionallyClosed = false;
      if (socket && (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)) return;
      openSocket();
    },
    disconnect() {
      intentionallyClosed = true;
      clearTimers();
      for (const subscription of subscriptions.values()) closeSseFor(subscription);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
      setStatus('idle');
    },
    subscribeConversation(conversationId, handler) {
      let subscription = subscriptions.get(conversationId);
      if (!subscription) {
        subscription = { conversationId, handlers: new Set() };
        subscriptions.set(conversationId, subscription);
      }
      subscription.handlers.add(handler);
      // Subscribing implies wanting events: bring the transport up if nothing
      // is connected yet. `connect()` is idempotent and never throws.
      if (!socket && status === 'idle' && !intentionallyClosed) openSocket();
      if (preferSse || status === 'sse') openSseFor(subscription);
      resubscribe();
      return () => {
        const current = subscriptions.get(conversationId);
        if (!current) return;
        current.handlers.delete(handler);
        if (current.handlers.size === 0) {
          closeSseFor(current);
          subscriptions.delete(conversationId);
          resubscribe();
        }
      };
    },
    unsubscribeConversation(conversationId) {
      const subscription = subscriptions.get(conversationId);
      if (!subscription) return;
      closeSseFor(subscription);
      subscriptions.delete(conversationId);
      resubscribe();
    },
    onStatus(callback) {
      statusListeners.add(callback);
      return () => statusListeners.delete(callback);
    },
    getStatus() {
      return status;
    },
    getLastEventId() {
      return lastEventId;
    },
    sendTyping(conversationId, isTyping) {
      if (socket && socket.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'typing', conversationId, isTyping }));
          return;
        } catch {
          /* fall through to REST */
        }
      }
      void apiTyping(conversationId, isTyping);
    },
  };
}

/** Event types the SSE route emits by name. */
const SSE_EVENT_TYPES = [
  'message.created',
  'message.updated',
  'message.deleted',
  'message.delivered',
  'message.read',
  'typing',
  'media.viewed',
  'conversation.read',
  'call.state',
  'call.accepted',
];

/** REST fallback for typing when no socket is open (lazy: keeps the import graph small). */
async function apiTyping(conversationId: string, isTyping: boolean): Promise<void> {
  try {
    const { api } = await import('@/lib/client/api');
    await api.conversations.typing(conversationId, isTyping);
  } catch {
    // Typing indicators are best effort.
  }
}

let instance: RealtimeClient | null = null;

export function getRealtimeClient(): RealtimeClient {
  if (!instance) instance = createRealtimeClient();
  return instance;
}

/** Test helper: drop the singleton. */
export function resetRealtimeClient(): void {
  instance?.disconnect();
  instance = null;
}

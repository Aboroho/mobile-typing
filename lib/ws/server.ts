/**
 * Authenticated WebSocket server for realtime chat events.
 *
 * Bootstrapped by the standalone server (server.ts) via tsx or bundled at
 * build time. Verifies `mt_session` cookies against the database-backed session
 * service, tracks connections per user, subscribes to the in-process event bus
 * for conversations the client is *proven* to belong to, and replays durable
 * OutboxEvents after a reconnect.
 *
 * Security rules enforced here:
 *  - the handshake is rejected with 401 unless a valid session cookie is
 *    presented; there is no anonymous connection;
 *  - `subscribe` re-checks conversation membership server side. Client-supplied
 *    conversation ids and user ids are never trusted;
 *  - every outbound frame passes `eventAddressedTo()`, so a payload rendered
 *    for the other participant is never delivered here;
 *  - typing frames are validated and republished with the *authenticated* user
 *    id, never a client-claimed one.
 *
 * WebSocket is transport only — PostgreSQL is the source of truth, and a socket
 * failure never invalidates a completed REST operation.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';
import { verifySession } from '../auth/session';
import { logger } from '../logger';
import { eventAddressedTo, publish, subscribe, topics } from '../realtime/bus';
import { getData } from '../data';
import type { OutboxEventRecord } from '../data/types';

export interface WireEvent {
  id?: string;
  topic: string;
  type: string;
  payload: unknown;
  at: string;
}

interface Client {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>;
  lastEventId: string | null;
  isAlive: boolean;
  ip: string | null;
  connectedAt: number;
}

const HEARTBEAT_MS = 30_000;
const MAX_SUBSCRIPTIONS = 32;
const MAX_CATCH_UP = 200;

export interface KeypadWSServer {
  /** Request path this server answers, e.g. `/api/v1/ws`. */
  readonly path: string;
  /**
   * Completes the handshake for an `upgrade` request on `path`. Callers are
   * expected to route by path first (see lib/ws/upgrade.ts): a request for any
   * other path is closed here as a last line of defence, so this must never
   * be handed a socket that belongs to somebody else — Next.js' dev HMR
   * socket at `/_next/hmr` in particular.
   */
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
  clientsFor(userId: string): number;
  /** How many live sockets a user has — used for presence fan-out and tests. */
  connectedUsers(): string[];
  close(): Promise<void>;
}

function frame(topic: string, type: string, payload: unknown, id?: string): WireEvent {
  return { ...(id ? { id } : {}), topic, type, payload, at: new Date().toISOString() };
}

export function createKeypadWSServer(options: { path?: string } = {}): KeypadWSServer {
  const path = options.path ?? '/api/v1/ws';
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();
  const unsubs = new Map<Client, Array<() => void>>();

  function send(c: Client, evt: WireEvent): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    try {
      c.ws.send(JSON.stringify(evt));
    } catch (err) {
      logger.warn('ws.send_failed', { error: String(err), userId: c.userId });
    }
  }

  function applySubscriptions(c: Client, conversationIds: string[]): void {
    for (const unsubscribe of unsubs.get(c) ?? []) unsubscribe();

    // User-scoped topics are always on: calls, access state and presence do not
    // depend on which conversation the client is looking at.
    const fresh: Array<() => void> = [
      subscribe(topics.userCalls(c.userId), (evt) => send(c, evt)),
      subscribe(`user:${c.userId}:access`, (evt) => send(c, evt)),
      subscribe(`user:${c.userId}:presence`, (evt) => send(c, evt)),
    ];

    c.subscriptions = new Set(conversationIds);
    for (const cid of c.subscriptions) {
      // Every conversation frame is filtered by recipient before it leaves.
      const forward = (evt: { topic: string; type: string; payload: unknown }) => {
        if (!eventAddressedTo(evt, c.userId)) return;
        send(c, { topic: evt.topic, type: evt.type, payload: evt.payload, at: new Date().toISOString() });
      };
      fresh.push(subscribe(topics.messages(cid), forward));
      fresh.push(subscribe(topics.conversation(cid), forward));
      fresh.push(subscribe(topics.typing(cid), forward));
      fresh.push(subscribe(topics.call(cid), forward));
    }
    unsubs.set(c, fresh);
  }

  /** Replays durable events the client missed, newest-cursor onwards. */
  async function catchUp(c: Client): Promise<number> {
    const data = await getData();
    const events: OutboxEventRecord[] = await data.outbox.listForUser(c.userId, c.lastEventId, MAX_CATCH_UP);
    for (const evt of events) {
      send(c, frame(evt.topic, evt.type, evt.payload, evt.id));
      if (!c.lastEventId || evt.id > c.lastEventId) c.lastEventId = evt.id;
    }
    return events.length;
  }

  async function onMessage(c: Client, raw: string): Promise<void> {
    let msg: { type?: string; conversations?: unknown; since?: unknown; isTyping?: unknown; conversationId?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      send(c, frame('system', 'error', { code: 'BAD_FRAME', message: 'expected a JSON frame' }));
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        const requested = Array.isArray(msg.conversations)
          ? msg.conversations.filter((v): v is string => typeof v === 'string' && v.length > 0)
          : [];
        if (typeof msg.since === 'string' && msg.since.length > 0) c.lastEventId = msg.since;

        // Membership is verified per conversation. Anything the user is not a
        // participant of is refused, and the refusal is reported back so the
        // client can stop retrying it.
        const data = await getData();
        const allowed: string[] = [];
        const refused: string[] = [];
        for (const cid of requested.slice(0, MAX_SUBSCRIPTIONS)) {
          const conversation = await data.conversations.getById(cid);
          if (conversation && conversation.participantIds.includes(c.userId)) allowed.push(cid);
          else refused.push(cid);
        }
        applySubscriptions(c, allowed);
        const replayed = await catchUp(c);
        if (refused.length > 0) logger.warn('ws.subscribe_refused', { userId: c.userId, count: refused.length });
        send(
          c,
          frame('system', 'subscribed', {
            conversations: Array.from(c.subscriptions),
            refused,
            replayed,
            lastEventId: c.lastEventId,
          }),
        );
        return;
      }
      case 'typing': {
        // Ephemeral: never persisted. The sender id comes from the session, so
        // a client cannot claim to be typing as somebody else.
        const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : '';
        if (!conversationId) return;
        const data = await getData();
        const conversation = await data.conversations.getById(conversationId);
        if (!conversation || !conversation.participantIds.includes(c.userId)) return;
        publish(topics.typing(conversationId), 'typing', {
          conversationId,
          userId: c.userId,
          isTyping: msg.isTyping !== false,
          otherUserId: conversation.participantIds.find((id) => id !== c.userId) ?? null,
        });
        return;
      }
      case 'ping':
        c.isAlive = true;
        send(c, frame('system', 'pong', { at: Date.now() }));
        return;
      default:
        send(c, frame('system', 'error', { code: 'UNKNOWN_FRAME', message: `unsupported type: ${String(msg.type)}` }));
    }
  }

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, client: Client) => {
    ws.on('message', (buf) => {
      void onMessage(client, buf.toString('utf8'));
    });
    ws.on('close', () => detach(client));
    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('error', () => detach(client));
    attach(client);
    send(client, frame('system', 'hello', { userId: client.userId, serverTime: new Date().toISOString() }));
    // Missed events are replayed by the `subscribe` frame, which carries the
    // client's cursor. Replaying here as well would send the same durable
    // events twice.
  });

  function attach(c: Client): void {
    clients.add(c);
    applySubscriptions(c, []);
    publish(`user:${c.userId}:presence`, 'presence.updated', { userId: c.userId, presence: 'online' });
    logger.info('ws.connected', { userId: c.userId, total: clients.size });
  }

  function detach(c: Client): void {
    if (!clients.has(c)) return;
    clients.delete(c);
    for (const unsubscribe of unsubs.get(c) ?? []) unsubscribe();
    unsubs.delete(c);
    try {
      c.ws.close();
    } catch {
      /* already closed */
    }
    if (clientsFor(c.userId) === 0) {
      publish(`user:${c.userId}:presence`, 'presence.updated', { userId: c.userId, presence: 'offline' });
    }
    logger.info('ws.disconnected', { userId: c.userId, total: clients.size });
  }

  async function authenticate(req: IncomingMessage): Promise<Client | null> {
    try {
      const verified = await verifySession(req);
      if (!verified) return null;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const forwarded = req.headers['x-forwarded-for'];
      const ip =
        (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ??
        (req.socket as { remoteAddress?: string }).remoteAddress ??
        null;
      const since = url.searchParams.get('since');
      return {
        ws: null as unknown as WebSocket,
        userId: verified.uid,
        subscriptions: new Set(),
        lastEventId: since && since.length > 0 ? since : null,
        isAlive: true,
        ip,
        connectedAt: Date.now(),
      };
    } catch (err) {
      logger.warn('ws.auth_failed', { error: String(err) });
      return null;
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    authenticate(req)
      .then((client) => {
        if (!client) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          client.ws = ws;
          wss.emit('connection', ws, req, client);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        socket.destroy();
      });
  }

  function clientsFor(userId: string): number {
    let n = 0;
    for (const c of clients) if (c.userId === userId) n += 1;
    return n;
  }

  const heartbeat = setInterval(() => {
    for (const c of Array.from(clients)) {
      if (!c.isAlive) {
        // No pong since the previous tick: the peer is gone.
        detach(c);
        continue;
      }
      c.isAlive = false;
      try {
        c.ws.ping();
      } catch {
        detach(c);
      }
    }
  }, HEARTBEAT_MS);

  return {
    path,
    handleUpgrade,
    clientsFor,
    connectedUsers() {
      return Array.from(new Set(Array.from(clients).map((c) => c.userId)));
    },
    async close() {
      clearInterval(heartbeat);
      for (const c of Array.from(clients)) {
        try {
          c.ws.close(1001, 'server shutting down');
        } catch {
          /* ignore */
        }
        detach(c);
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

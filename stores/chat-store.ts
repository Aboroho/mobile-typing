import { create } from 'zustand';
import type { ConversationView, IceServer, MessageForUser, UserSearchResult } from '@mt/types';
import { MESSAGE_PAGE_SIZE, RECEIPT_BATCH_DELAY_MS } from '@mt/types';
import {
  applyDeliveryState,
  applyOptimistic,
  applyReadWatermark,
  markDeleted,
  markSendFailed,
  mergeMessage,
  mergeMessages,
  messageKey,
  newestCanonical,
  oldestCanonical,
  optimisticCreatedAt,
  pendingDeliveryIds,
  removeByKey,
} from '@mt/domain';
import { newId } from '@mt/utils';
import type { SendMediaMessageInput, SendMessageInput } from '@mt/validation';
import { api } from '@/lib/client/api';
import { connectEventStream } from '@/lib/browser/sse-client';
import {
  createTypingPublisher,
  createTypingReceiver,
  type TypingPublisher,
  type TypingReceiver,
} from '@/lib/browser/typing-indicator';
import { useUiStore } from './ui-store';
import { useAuthStore } from './auth-store';
import { errorMessage } from './access-store';

/**
 * Chat state — the single source of truth for conversations and messages.
 *
 * `messages[conversationId]` is a normalised, ordered list maintained solely
 * through the pure merge functions in `@mt/domain` (message-sync). Every input
 * — optimistic placeholders, send responses, stream events, pages, reconnect
 * catch-ups, receipts — goes through those functions, which is what guarantees
 * that a message is never shown twice however the sources race. Components
 * only read; they never append.
 *
 * Message states (docs/messaging-sync.md):
 *   sending → sent → delivered → read, with sending → failed → sending (retry).
 */
interface ChatState {
  conversations: ConversationView[];
  loadingConversations: boolean;
  activeConversationId: string | null;
  activeConversation: ConversationView | null;
  /** Per conversation: `idle` (never opened), `loading`, `ready`, or `error`. */
  loadState: Record<string, 'loading' | 'ready' | 'error'>;
  messages: Record<string, MessageForUser[]>;
  hasMore: Record<string, boolean>;
  loadingOlder: Record<string, boolean>;
  typingPeer: Record<string, boolean>;
  /** Live stream status per conversation, for a subtle "reconnecting…" hint. */
  streamState: Record<string, 'connecting' | 'live' | 'reconnecting'>;
  /** True while at least one send request is in flight (per-message state lives on the message). */
  sending: boolean;
  iceServers: IceServer[];

  loadConversations: () => Promise<void>;
  createConversation: (participantId: string) => Promise<string | null>;
  openConversation: (conversationId: string) => Promise<void>;
  /** Re-fetches the latest page and merges it, without touching the stream. */
  refreshConversation: (conversationId: string) => Promise<void>;
  leaveConversation: (conversationId?: string) => void;
  loadOlderMessages: (conversationId: string) => Promise<void>;
  sendText: (conversationId: string, text: string, replyToId?: string) => Promise<void>;
  sendMedia: (input: {
    conversationId: string;
    mediaId: string;
    type: 'image' | 'voice';
    caption?: string;
    viewOnce?: boolean;
  }) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string, scope: 'everyone' | 'me') => Promise<void>;
  /** Re-sends a failed message with its original idempotency key. */
  retry: (conversationId: string, clientMessageId: string) => Promise<void>;
  /** Drops a failed message that the user does not want to resend. */
  discardFailed: (conversationId: string, clientMessageId: string) => void;
  /**
   * Reports that a peer message was actually rendered in a visible, focused
   * window. Drives the read watermark; batched and de-duplicated internally.
   */
  reportMessageSeen: (conversationId: string, message: Pick<MessageForUser, 'id' | 'senderId' | 'createdAt'>) => void;
  /** Composer activity for the typing indicator (throttled internally). */
  noteComposerActivity: (conversationId: string, hasContent: boolean) => void;
  stopTyping: (conversationId: string) => void;
  searchUsers: (q: string) => Promise<UserSearchResult[]>;
  hideConversation: (conversationId: string) => Promise<void>;
  /** Forgets everything private. Used by the privacy lock. */
  reset: () => void;
}

/** The signed-in user's id; optimistic messages must carry the real sender. */
function selfId(): string {
  return useAuthStore.getState().user?.id ?? 'me';
}

/**
 * Per-conversation runtime that must not live in React state: the stream
 * disconnect function, typing publisher/receiver, receipt batching and the
 * payload of every in-flight send (for retries).
 */
interface Session {
  disconnect: (() => void) | null;
  publisher: TypingPublisher | null;
  receiver: TypingReceiver | null;
  /** Ids awaiting a `delivered` receipt, flushed in one request. */
  deliveryQueue: Set<string>;
  deliveryTimer: ReturnType<typeof setTimeout> | null;
  /** Ids for which a `delivered` request is in flight (no double sends). */
  deliveryInFlight: Set<string>;
  /** Highest watermark reported to the server, and the one waiting to be sent. */
  readSentAt: string | null;
  readPendingAt: string | null;
  readTimer: ReturnType<typeof setTimeout> | null;
  readInFlight: boolean;
  /** How many times the stream connected; > 1 means a reconnect. */
  connections: number;
  /** Bumped by every open/leave so stale async work can bail out. */
  epoch: number;
}

const sessions = new Map<string, Session>();
/** Everything needed to re-send a message with the same idempotency key. */
const pendingSends = new Map<string, SendMessageInput | SendMediaMessageInput>();
/** Number of send requests currently in flight (drives the `sending` flag). */
let inFlightSends = 0;

function session(conversationId: string): Session {
  let current = sessions.get(conversationId);
  if (!current) {
    current = {
      disconnect: null,
      publisher: null,
      receiver: null,
      deliveryQueue: new Set(),
      deliveryTimer: null,
      deliveryInFlight: new Set(),
      readSentAt: null,
      readPendingAt: null,
      readTimer: null,
      readInFlight: false,
      connections: 0,
      epoch: 0,
    };
    sessions.set(conversationId, current);
  }
  return current;
}

type SetState = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;

/** Functional update of one conversation's list; skips the render when nothing changed. */
function updateList(
  set: SetState,
  conversationId: string,
  update: (list: MessageForUser[]) => MessageForUser[],
): void {
  set((state) => {
    const current = state.messages[conversationId] ?? [];
    const next = update(current);
    if (next === current) return {};
    return { messages: { ...state.messages, [conversationId]: next } };
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  loadingConversations: false,
  activeConversationId: null,
  activeConversation: null,
  loadState: {},
  messages: {},
  hasMore: {},
  loadingOlder: {},
  typingPeer: {},
  streamState: {},
  sending: false,
  iceServers: [],

  async loadConversations() {
    set({ loadingConversations: true });
    try {
      const result = await api.conversations.list({ limit: 30 });
      set({ conversations: result.items, loadingConversations: false });
    } catch (error) {
      set({ loadingConversations: false });
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async createConversation(participantId) {
    try {
      const { conversation } = await api.conversations.create(participantId);
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation) }));
      return conversation.conversation.id;
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
      return null;
    }
  },

  async openConversation(conversationId) {
    const current = session(conversationId);
    const epoch = ++current.epoch;
    set((state) => ({
      activeConversationId: conversationId,
      loadState: { ...state.loadState, [conversationId]: 'loading' },
    }));
    try {
      const [detail, page] = await Promise.all([
        api.conversations.get(conversationId),
        api.messages.list(conversationId, { limit: MESSAGE_PAGE_SIZE }),
      ]);
      // Left (or re-opened) while loading: the newer open owns the state now.
      if (current.epoch !== epoch || get().activeConversationId !== conversationId) return;

      set((state) => ({
        activeConversation: detail.conversation,
        iceServers: detail.iceServers,
        // Merge, never replace: unsent/failed local messages and pages that
        // were already loaded survive a re-open.
        messages: { ...state.messages, [conversationId]: mergeMessages(state.messages[conversationId] ?? [], page.items) },
        hasMore: { ...state.hasMore, [conversationId]: page.hasMore },
        loadState: { ...state.loadState, [conversationId]: 'ready' },
      }));
      subscribe(conversationId, set, get);
      acknowledgeDelivered(conversationId, set, get);
    } catch (error) {
      if (current.epoch !== epoch) return;
      set((state) => ({ loadState: { ...state.loadState, [conversationId]: 'error' } }));
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async refreshConversation(conversationId) {
    try {
      const page = await api.messages.list(conversationId, { limit: MESSAGE_PAGE_SIZE });
      updateList(set, conversationId, (list) => mergeMessages(list, page.items));
      acknowledgeDelivered(conversationId, set, get);
    } catch {
      // A failed refresh leaves the current list in place; the stream continues.
    }
  },

  leaveConversation(conversationId) {
    const id = conversationId ?? get().activeConversationId;
    if (id) teardownSession(id);
    set((state) => ({
      activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
      activeConversation: state.activeConversationId === id ? null : state.activeConversation,
      typingPeer: id ? { ...state.typingPeer, [id]: false } : state.typingPeer,
    }));
  },

  async loadOlderMessages(conversationId) {
    const before = oldestCanonical(get().messages[conversationId] ?? [])?.createdAt;
    if (!before || !get().hasMore[conversationId] || get().loadingOlder[conversationId]) return;
    set((state) => ({ loadingOlder: { ...state.loadingOlder, [conversationId]: true } }));
    try {
      const page = await api.messages.list(conversationId, { limit: MESSAGE_PAGE_SIZE, before });
      set((state) => ({
        // Merging (not concatenating) keeps a message that arrived live while
        // the page was loading, and drops any overlap with the page.
        messages: { ...state.messages, [conversationId]: mergeMessages(state.messages[conversationId] ?? [], page.items) },
        hasMore: { ...state.hasMore, [conversationId]: page.hasMore },
        loadingOlder: { ...state.loadingOlder, [conversationId]: false },
      }));
      acknowledgeDelivered(conversationId, set, get);
    } catch (error) {
      set((state) => ({ loadingOlder: { ...state.loadingOlder, [conversationId]: false } }));
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async sendText(conversationId, text, replyToId) {
    const clientMessageId = newId('cmsg');
    const input: SendMessageInput = {
      conversationId,
      type: 'text',
      text,
      clientMessageId,
      replyTo: replyToId ? { messageId: replyToId } : undefined,
    };
    get().stopTyping(conversationId);
    await performSend(conversationId, input, set, get);
  },

  async sendMedia({ conversationId, mediaId, type, caption, viewOnce }) {
    const clientMessageId = newId('cmsg');
    const input: SendMediaMessageInput = { conversationId, mediaId, type, caption, clientMessageId, viewOnce };
    await performSend(conversationId, input, set, get);
  },

  async editMessage(messageId, text) {
    try {
      const result = await api.messages.edit(messageId, { text });
      updateList(set, result.message.conversationId, (list) => mergeMessage(list, result.message));
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async deleteMessage(messageId, scope) {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    if (scope === 'me') {
      updateList(set, conversationId, (list) => list.filter((message) => message.id !== messageId));
    }
    try {
      await api.messages.remove(messageId, { scope });
      if (scope === 'everyone') updateList(set, conversationId, (list) => markDeleted(list, messageId));
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async retry(conversationId, clientMessageId) {
    const input = pendingSends.get(clientMessageId);
    const existing = (get().messages[conversationId] ?? []).find(
      (message) => message.clientMessageId === clientMessageId,
    );
    if (!input || !existing || existing.deliveryState !== 'failed') return;
    // Same clientMessageId: if the first attempt did reach the server, it
    // answers with the original message instead of storing a second one.
    await performSend(conversationId, input, set, get);
  },

  discardFailed(conversationId, clientMessageId) {
    pendingSends.delete(clientMessageId);
    updateList(set, conversationId, (list) => {
      const target = list.find((message) => message.clientMessageId === clientMessageId);
      return target && target.deliveryState === 'failed' ? removeByKey(list, messageKey(target)) : list;
    });
  },

  reportMessageSeen(conversationId, message) {
    if (message.senderId === selfId()) return;
    const current = session(conversationId);
    const candidate = message.createdAt;
    const highest = [current.readSentAt, current.readPendingAt].filter(Boolean).sort().pop() ?? null;
    if (highest && candidate <= highest) return;
    current.readPendingAt = candidate;
    if (current.readTimer) return;
    current.readTimer = setTimeout(() => {
      current.readTimer = null;
      void flushRead(conversationId, set, get);
    }, RECEIPT_BATCH_DELAY_MS);
  },

  noteComposerActivity(conversationId, hasContent) {
    const current = session(conversationId);
    if (!current.publisher) {
      current.publisher = createTypingPublisher({
        send: (isTyping) => api.conversations.typing(conversationId, isTyping).then(() => undefined),
      });
    }
    current.publisher.noteActivity(hasContent);
  },

  stopTyping(conversationId) {
    sessions.get(conversationId)?.publisher?.stop();
  },

  async searchUsers(q) {
    if (!q.trim()) return [];
    try {
      const { items } = await api.users.search(q, 20);
      return items;
    } catch {
      return [];
    }
  },

  async hideConversation(conversationId) {
    try {
      await api.conversations.hide(conversationId, true);
      set((state) => ({
        conversations: state.conversations.filter((item) => item.conversation.id !== conversationId),
      }));
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  reset() {
    disconnectAllStreams();
    pendingSends.clear();
    inFlightSends = 0;
    set({
      conversations: [],
      loadingConversations: false,
      activeConversationId: null,
      activeConversation: null,
      loadState: {},
      messages: {},
      hasMore: {},
      loadingOlder: {},
      typingPeer: {},
      streamState: {},
      sending: false,
    });
  },
}));

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * One code path for first sends and retries: insert/re-arm the placeholder,
 * POST with the idempotency key, reconcile the canonical message. The stream
 * usually delivers the canonical copy first; both paths go through
 * `mergeMessage`, which matches it to the placeholder by `clientMessageId`.
 */
async function performSend(
  conversationId: string,
  input: SendMessageInput | SendMediaMessageInput,
  set: SetState,
  get: () => ChatState,
): Promise<void> {
  const { clientMessageId } = input;
  pendingSends.set(clientMessageId, input);
  updateList(set, conversationId, (list) => applyOptimistic(list, optimisticMessage(list, input)));
  inFlightSends += 1;
  set({ sending: true });
  try {
    const result =
      input.type === 'text'
        ? await api.messages.send(input as SendMessageInput)
        : await api.media.send(input as SendMediaMessageInput);
    pendingSends.delete(clientMessageId);
    set((state) => ({
      messages: { ...state.messages, [conversationId]: mergeMessage(state.messages[conversationId] ?? [], result.message) },
      conversations: upsertConversation(state.conversations, result.conversation),
    }));
  } catch (error) {
    // `markSendFailed` ignores the failure if the stream already confirmed the
    // message (request timed out after the server stored it).
    updateList(set, conversationId, (list) => markSendFailed(list, clientMessageId));
    const stillFailed = (get().messages[conversationId] ?? []).some(
      (message) => message.clientMessageId === clientMessageId && message.deliveryState === 'failed',
    );
    if (stillFailed) useUiStore.getState().pushToast(errorMessage(error), 'error');
    else pendingSends.delete(clientMessageId);
  } finally {
    inFlightSends = Math.max(0, inFlightSends - 1);
    set({ sending: inFlightSends > 0 });
  }
}

function optimisticMessage(
  list: readonly MessageForUser[],
  input: SendMessageInput | SendMediaMessageInput,
): MessageForUser {
  const now = optimisticCreatedAt(list);
  const isText = input.type === 'text';
  const replyToId = isText ? (input as SendMessageInput).replyTo?.messageId : undefined;
  const replyTarget = replyToId ? list.find((message) => message.id === replyToId) : undefined;
  return {
    id: input.clientMessageId,
    conversationId: input.conversationId,
    senderId: selfId(),
    type: input.type,
    text: isText ? (input as SendMessageInput).text ?? '' : ((input as SendMediaMessageInput).caption ?? null),
    // Media bytes are already uploaded; the bubble shows a placeholder until the
    // canonical message (with its media view) arrives.
    media: null,
    call: null,
    replyTo: replyToId
      ? {
          messageId: replyToId,
          senderId: replyTarget?.senderId ?? '',
          type: replyTarget?.type ?? 'text',
          preview: replyTarget?.text ?? '',
          createdAt: replyTarget?.createdAt ?? now,
        }
      : null,
    deliveryState: 'sending',
    deliveredAt: null,
    readBy: [],
    readAt: null,
    edited: false,
    editedAt: null,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    clientMessageId: input.clientMessageId,
    createdAt: now,
    updatedAt: now,
  };
}

function upsertConversation(list: ConversationView[], conversation: ConversationView): ConversationView[] {
  const exists = list.some((item) => item.conversation.id === conversation.conversation.id);
  if (!exists) return [conversation, ...list];
  return list.map((item) => (item.conversation.id === conversation.conversation.id ? conversation : item));
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * "Delivered" = this device has synchronised the message. Queued for every peer
 * message still in `sent` after a page load or a stream event, flushed in one
 * request. Independent of visibility: a hidden tab that receives a message has
 * received it. Never sent for the user's own messages.
 */
function acknowledgeDelivered(conversationId: string, set: SetState, get: () => ChatState): void {
  const current = session(conversationId);
  const ids = pendingDeliveryIds(get().messages[conversationId] ?? [], selfId()).filter(
    (id) => !current.deliveryInFlight.has(id),
  );
  for (const id of ids) current.deliveryQueue.add(id);
  if (current.deliveryQueue.size === 0 || current.deliveryTimer) return;
  current.deliveryTimer = setTimeout(() => {
    current.deliveryTimer = null;
    void flushDelivered(conversationId, set, get);
  }, RECEIPT_BATCH_DELAY_MS);
}

async function flushDelivered(conversationId: string, set: SetState, get: () => ChatState): Promise<void> {
  const current = session(conversationId);
  const ids = Array.from(current.deliveryQueue).slice(0, 100);
  if (ids.length === 0) return;
  for (const id of ids) {
    current.deliveryQueue.delete(id);
    current.deliveryInFlight.add(id);
  }
  try {
    await api.messages.markDelivered(conversationId, { messageIds: ids, state: 'delivered' });
    // Mirror locally: the server only notifies the *author* of the change.
    updateList(set, conversationId, (list) => applyDeliveryState(list, ids, 'delivered', new Date().toISOString()));
  } catch {
    // Offline or rejected: the ids are re-queued by the next sync (open,
    // reconnect, next stream event), so nothing is lost.
  } finally {
    for (const id of ids) current.deliveryInFlight.delete(id);
  }
  if (current.deliveryQueue.size > 0) acknowledgeDelivered(conversationId, set, get);
}

/** Sends the highest pending read watermark once; coalesces bursts. */
async function flushRead(conversationId: string, set: SetState, get: () => ChatState): Promise<void> {
  const current = session(conversationId);
  if (current.readInFlight) return;
  const watermark = current.readPendingAt;
  if (!watermark || (current.readSentAt && watermark <= current.readSentAt)) {
    current.readPendingAt = null;
    return;
  }
  current.readInFlight = true;
  current.readPendingAt = null;
  try {
    const result = await api.conversations.markRead(conversationId, { lastReadMessageAt: watermark });
    current.readSentAt = watermark;
    const at = new Date().toISOString();
    const peerId = get().activeConversation?.otherUser.id;
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: peerId
          ? applyReadWatermark(state.messages[conversationId] ?? [], peerId, watermark, at)
          : applyDeliveryState(state.messages[conversationId] ?? [], result.messageIds ?? [], 'read', at),
      },
      conversations: state.conversations.map((item) =>
        item.conversation.id === conversationId ? { ...item, unreadCount: 0 } : item,
      ),
    }));
  } catch {
    // Retry on the next visibility report; the watermark is monotonic so a
    // later, higher one simply supersedes this attempt.
    current.readPendingAt = watermark;
  } finally {
    current.readInFlight = false;
  }
  if (current.readPendingAt && current.readPendingAt !== watermark) void flushRead(conversationId, set, get);
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

/**
 * Exactly one stream per open conversation. Reconnects (the EventSource wrapper
 * backs off and retries by itself) trigger a catch-up fetch so events missed
 * while offline are merged rather than lost.
 */
function subscribe(conversationId: string, set: SetState, get: () => ChatState): void {
  const current = session(conversationId);
  current.disconnect?.();
  current.connections = 0;
  current.receiver?.dispose();
  current.receiver = createTypingReceiver({
    onChange: (isTyping) => set((state) => ({ typingPeer: { ...state.typingPeer, [conversationId]: isTyping } })),
  });
  set((state) => ({ streamState: { ...state.streamState, [conversationId]: 'connecting' } }));

  const self = selfId();
  const disconnect = connectEventStream({
    url: `/api/v1/conversations/${conversationId}/events`,
    onReady: () => {
      current.connections += 1;
      set((state) => ({ streamState: { ...state.streamState, [conversationId]: 'live' } }));
      if (current.connections > 1) void catchUp(conversationId, set, get);
    },
    onError: () => {
      set((state) => ({ streamState: { ...state.streamState, [conversationId]: 'reconnecting' } }));
    },
    events: {
      'message.created': (payload) => {
        const message = (payload as { message: MessageForUser }).message;
        updateList(set, conversationId, (list) => mergeMessage(list, message));
        if (message.senderId !== self) {
          // Their message arrived, so they are no longer "typing…".
          current.receiver?.clear();
          acknowledgeDelivered(conversationId, set, get);
        }
      },
      'message.updated': (payload) => {
        const message = (payload as { message: MessageForUser }).message;
        updateList(set, conversationId, (list) => mergeMessage(list, message));
      },
      'message.deleted': (payload) => {
        const { messageId } = payload as { messageId: string };
        updateList(set, conversationId, (list) => markDeleted(list, messageId));
      },
      'message.delivery': (payload) => {
        const { messageIds, state: deliveryState, at } = payload as {
          messageIds: string[];
          state: 'delivered' | 'read';
          at?: string;
        };
        updateList(set, conversationId, (list) => applyDeliveryState(list, messageIds, deliveryState, at ?? null));
      },
      'conversation.read': (payload) => {
        // The peer read up to a watermark: everything of ours at or before it
        // is read. Also keeps a second tab of the *reader* consistent.
        const { userId, lastReadMessageAt, at } = payload as { userId: string; lastReadMessageAt: string; at?: string };
        if (userId === self) return;
        updateList(set, conversationId, (list) => applyReadWatermark(list, self, lastReadMessageAt, at ?? null));
      },
      typing: (payload) => {
        const { isTyping, userId } = payload as { isTyping: boolean; userId?: string };
        if (userId && userId === self) return;
        current.receiver?.receive(isTyping);
      },
      'media.viewed': () => {
        void get().refreshConversation(conversationId);
      },
    },
  });
  current.disconnect = disconnect;
}

/**
 * After a reconnect: merge the latest page (which also refreshes delivery
 * states) and, if more than a page arrived meanwhile, everything after the
 * newest message we already had.
 */
async function catchUp(conversationId: string, set: SetState, get: () => ChatState): Promise<void> {
  const previousNewest = newestCanonical(get().messages[conversationId] ?? []);
  try {
    const page = await api.messages.list(conversationId, { limit: MESSAGE_PAGE_SIZE });
    updateList(set, conversationId, (list) => mergeMessages(list, page.items));
    const gap =
      previousNewest &&
      page.items.length >= MESSAGE_PAGE_SIZE &&
      !page.items.some((item) => item.id === previousNewest.id);
    if (gap) {
      const tail = await api.messages.list(conversationId, { limit: 100, after: previousNewest.createdAt });
      updateList(set, conversationId, (list) => mergeMessages(list, tail.items));
    }
    acknowledgeDelivered(conversationId, set, get);
  } catch {
    // The stream is live again; the next event or open fills the gap.
  }
}

function teardownSession(conversationId: string): void {
  const current = sessions.get(conversationId);
  if (!current) return;
  current.epoch += 1;
  current.disconnect?.();
  current.disconnect = null;
  current.publisher?.dispose();
  current.publisher = null;
  current.receiver?.dispose();
  current.receiver = null;
  if (current.deliveryTimer) clearTimeout(current.deliveryTimer);
  current.deliveryTimer = null;
  if (current.readTimer) clearTimeout(current.readTimer);
  current.readTimer = null;
  current.readPendingAt = null;
  current.deliveryQueue.clear();
}

/** Stops every stream, typing indicator and pending receipt — used by the privacy lock. */
export function disconnectAllStreams(): void {
  for (const id of Array.from(sessions.keys())) teardownSession(id);
}

/** Stops outgoing typing indicators everywhere (page hidden, chat closed). */
export function stopAllTyping(): void {
  for (const current of sessions.values()) current.publisher?.stop();
}

/** Test seam: clears runtime sessions between tests. */
export function __resetChatRuntimeForTests(): void {
  disconnectAllStreams();
  sessions.clear();
  pendingSends.clear();
}

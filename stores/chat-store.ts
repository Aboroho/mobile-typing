import { create } from 'zustand';
import type { ConversationView, IceServer, MessageForUser, UserSearchResult } from '@mt/types';
import { newId } from '@mt/utils';
import { api } from '@/lib/client/api';
import {
  applyDelivery,
  dedupeMessages,
  markFailed,
  mergePage,
  sortByTime,
  upsertMessage,
} from '@/lib/client/message-sync';
import { getRealtimeClient, type RealtimeEventFrame } from '@/lib/browser/realtime-client';
import { useRealtimeStore } from './realtime-store';
import { useUiStore } from './ui-store';
import { useAuthStore } from './auth-store';
import { errorMessage } from './access-store';

interface ChatState {
  conversations: ConversationView[];
  loadingConversations: boolean;
  activeConversationId: string | null;
  activeConversation: ConversationView | null;
  messages: Record<string, MessageForUser[]>;
  hasMore: Record<string, boolean>;
  /** Oldest loaded message timestamp; used as the `before` cursor. */
  oldestAt: Record<string, string | null>;
  typingPeer: Record<string, boolean>;
  /** Client messages currently in flight, per conversation. */
  pendingClientIds: Record<string, string[]>;
  iceServers: IceServer[];

  loadConversations: () => Promise<void>;
  createConversation: (participantId: string) => Promise<string | null>;
  openConversation: (conversationId: string) => Promise<void>;
  leaveConversation: () => void;
  loadOlderMessages: (conversationId: string) => Promise<void>;
  sendText: (conversationId: string, text: string, replyToId?: string, clientMessageId?: string) => Promise<void>;
  sendMedia: (input: {
    conversationId: string;
    mediaId: string;
    type: 'image' | 'voice';
    caption?: string;
    viewOnce?: boolean;
  }) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string, scope: 'everyone' | 'me') => Promise<void>;
  retry: (conversationId: string, clientMessageId: string, text: string) => Promise<void>;
  markRead: (conversationId: string) => Promise<void>;
  acknowledgeDelivery: (conversationId: string) => Promise<void>;
  setTyping: (conversationId: string, isTyping: boolean) => void;
  searchUsers: (q: string) => Promise<UserSearchResult[]>;
  hideConversation: (conversationId: string) => Promise<void>;
}

/**
 * Live subscription per conversation, kept outside the store so it survives
 * re-renders and can be torn down exactly once.
 */
const streams = new Map<string, () => void>();

/**
 * Event ids already applied, per conversation. The server can legitimately
 * deliver the same durable event twice — once live and again as part of a
 * reconnect replay — so the client has to recognise it. Bounded so a long
 * session cannot grow this without limit.
 */
const seenEvents = new Map<string, Set<string>>();
const SEEN_EVENT_LIMIT = 500;

function rememberEvent(conversationId: string, eventId: string | undefined): boolean {
  if (!eventId) return true;
  let seen = seenEvents.get(conversationId);
  if (!seen) {
    seen = new Set<string>();
    seenEvents.set(conversationId, seen);
  }
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  if (seen.size > SEEN_EVENT_LIMIT) {
    // Drop the oldest half; ids are time-ordered so iteration order is age order.
    const drop = Array.from(seen).slice(0, SEEN_EVENT_LIMIT / 2);
    for (const id of drop) seen.delete(id);
  }
  return true;
}

function withMessages(
  state: ChatState,
  conversationId: string,
  update: (list: MessageForUser[]) => MessageForUser[],
): Partial<ChatState> {
  const current = state.messages[conversationId] ?? [];
  const next = update(current);
  if (next === current) return {};
  return { messages: { ...state.messages, [conversationId]: next } };
}

function upsertConversation(list: ConversationView[], conversation: ConversationView): ConversationView[] {
  const exists = list.some((item) => item.conversation.id === conversation.conversation.id);
  if (!exists) return [conversation, ...list];
  return list.map((item) => (item.conversation.id === conversation.conversation.id ? conversation : item));
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  loadingConversations: false,
  activeConversationId: null,
  activeConversation: null,
  messages: {},
  hasMore: {},
  oldestAt: {},
  typingPeer: {},
  pendingClientIds: {},
  iceServers: [],

  async loadConversations() {
    set({ loadingConversations: true });
    try {
      const result = await api.conversations.list({ limit: 30 });
      set({ conversations: result.items, loadingConversations: false });
      // Subscribe to every conversation, not just the open one: an incoming
      // message must arrive instantly no matter which screen the user is on,
      // and the conversation list (preview, unread badge) stays live too.
      for (const item of result.items) subscribe(item.conversation.id, set);
    } catch (error) {
      set({ loadingConversations: false });
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async createConversation(participantId) {
    try {
      const { conversation } = await api.conversations.create(participantId);
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation) }));
      subscribe(conversation.conversation.id, set);
      return conversation.conversation.id;
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
      return null;
    }
  },

  async openConversation(conversationId) {
    set({ activeConversationId: conversationId });
    try {
      const detail = await api.conversations.get(conversationId);
      const page = await api.messages.list(conversationId, { limit: 30 });
      set((state) => ({
        activeConversation: detail.conversation,
        iceServers: detail.iceServers,
        // Merge rather than replace: anything already optimistically inserted
        // (or received live while the fetch was in flight) is preserved.
        ...withMessages(state, conversationId, (list) => mergePage(list, page.items)),
        hasMore: { ...state.hasMore, [conversationId]: page.hasMore },
        oldestAt: { ...state.oldestAt, [conversationId]: page.items[0]?.createdAt ?? state.oldestAt[conversationId] ?? null },
      }));
      subscribe(conversationId, set);
      void get().markRead(conversationId);
      void get().acknowledgeDelivery(conversationId);
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  leaveConversation() {
    const id = get().activeConversationId;
    if (id) {
      // The live subscription is kept: messages for this conversation must
      // still arrive instantly (and keep the list fresh) while the user is on
      // another screen. Only the privacy lock tears subscriptions down.
      // Never leave a "typing…" bubble behind on the peer's screen.
      get().setTyping(id, false);
    }
    set({ activeConversationId: null, activeConversation: null, typingPeer: {} });
  },

  async loadOlderMessages(conversationId) {
    const before = get().oldestAt[conversationId];
    if (!before || !get().hasMore[conversationId]) return;
    const page = await api.messages.list(conversationId, { limit: 30, before });
    set((state) => ({
      ...withMessages(state, conversationId, (list) => mergePage(list, page.items)),
      hasMore: { ...state.hasMore, [conversationId]: page.hasMore },
      oldestAt: { ...state.oldestAt, [conversationId]: page.items[0]?.createdAt ?? before },
    }));
  },

  async sendText(conversationId, text, replyToId, reuseClientMessageId) {
    // A retry passes its original id back in: the server treats
    // (conversationId, senderId, clientMessageId) as an idempotency key, so a
    // resend of a message that actually landed cannot create a second row.
    const clientMessageId = reuseClientMessageId ?? newId('cmsg');
    const optimistic = optimisticMessage(conversationId, text, clientMessageId, replyToId);
    set((state) => ({
      ...withMessages(state, conversationId, (list) => upsertMessage(list, optimistic)),
      pendingClientIds: {
        ...state.pendingClientIds,
        [conversationId]: [...(state.pendingClientIds[conversationId] ?? []), clientMessageId],
      },
    }));
    try {
      const result = await api.messages.send({
        conversationId,
        type: 'text',
        text,
        clientMessageId,
        replyTo: replyToId ? { messageId: replyToId } : undefined,
      });
      set((state) => ({
        // Replace the optimistic copy with the canonical record. If a live
        // event already inserted the same message, `upsertMessage` recognises
        // it by clientMessageId and merges instead of duplicating.
        ...withMessages(state, conversationId, (list) => upsertMessage(list, result.message)),
        conversations: upsertConversation(state.conversations, result.conversation),
        pendingClientIds: {
          ...state.pendingClientIds,
          [conversationId]: (state.pendingClientIds[conversationId] ?? []).filter((id) => id !== clientMessageId),
        },
      }));
      // The peer has not necessarily seen it yet; the delivered/read receipts
      // arrive over the socket.
    } catch (error) {
      set((state) => ({
        ...withMessages(state, conversationId, (list) => markFailed(list, clientMessageId)),
        pendingClientIds: {
          ...state.pendingClientIds,
          [conversationId]: (state.pendingClientIds[conversationId] ?? []).filter((id) => id !== clientMessageId),
        },
      }));
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async sendMedia({ conversationId, mediaId, type, caption, viewOnce }) {
    const clientMessageId = newId('cmsg');
    try {
      const result = await api.media.send({ conversationId, mediaId, type, caption, clientMessageId, viewOnce });
      set((state) => ({
        ...withMessages(state, conversationId, (list) => upsertMessage(list, result.message)),
        conversations: upsertConversation(state.conversations, result.conversation),
      }));
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async editMessage(messageId, text) {
    try {
      const result = await api.messages.edit(messageId, { text });
      const conversationId = result.message.conversationId;
      set((state) => withMessages(state, conversationId, (list) => upsertMessage(list, result.message)));
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async deleteMessage(messageId, scope) {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    if (scope === 'me') {
      set((state) =>
        withMessages(state, conversationId, (list) => list.filter((message) => message.id !== messageId)),
      );
    }
    try {
      await api.messages.remove(messageId, { scope });
      if (scope === 'everyone') {
        set((state) =>
          withMessages(state, conversationId, (list) =>
            list.map((message) =>
              message.id === messageId ? { ...message, deleted: true, text: null, media: null } : message,
            ),
          ),
        );
      }
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  /**
   * Resends a failed message with its **original** clientMessageId. If the
   * first attempt actually reached the server, the idempotency key returns the
   * existing row instead of creating a duplicate.
   */
  async retry(conversationId, clientMessageId, text) {
    if (!clientMessageId) return;
    set((state) =>
      withMessages(state, conversationId, (list) =>
        list.map((message) =>
          message.clientMessageId === clientMessageId ? { ...message, deliveryState: 'sending' } : message,
        ),
      ),
    );
    await get().sendText(conversationId, text, undefined, clientMessageId);
  },

  async markRead(conversationId) {
    const messages = get().messages[conversationId] ?? [];
    const last = messages[messages.length - 1];
    if (!last) return;
    try {
      await api.conversations.markRead(conversationId, { lastReadMessageAt: last.createdAt });
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.conversation.id === conversationId ? { ...item, unreadCount: 0 } : item,
        ),
      }));
    } catch {
      // Read receipts are best effort.
    }
  },

  /**
   * Confirms receipt of everything the peer sent that this client now holds.
   * Only messages the *other* participant authored are acknowledged, and the
   * server re-checks both membership and authorship, so this cannot move
   * somebody else's receipts.
   */
  async acknowledgeDelivery(conversationId) {
    const state = get();
    const peerId = state.activeConversation?.otherUser.id;
    if (!peerId) return;
    // Only messages *the peer* authored can be acknowledged by us; our own
    // optimistic copies (senderId === our id) are never receipted by us.
    const received = (state.messages[conversationId] ?? []).filter(
      (message) => message.senderId === peerId && message.deliveryState === 'sent',
    );
    if (received.length === 0) return;
    try {
      await api.messages.markDelivered(conversationId, {
        messageIds: received.slice(0, 100).map((message) => message.id),
        state: 'delivered',
      });
    } catch {
      // Delivery receipts are best effort; the sender's view stays at "sent".
    }
  },

  /**
   * Typing indicator.
   *
   * Ephemeral by design: nothing is written to PostgreSQL. The transport is the
   * live WebSocket when there is one, otherwise a throttled REST call. The
   * caller (the composer) starts it on the first keystroke; this store owns the
   * automatic stop so the peer's indicator can never get stuck.
   */
  setTyping(conversationId, isTyping) {
    if (isTyping) {
      const timers = typingTimers.get(conversationId);
      // Only the first keystroke of a burst announces "typing"; later ones just
      // push the automatic stop further out. Without this the peer's socket
      // would receive a frame per character.
      if (!timers) getRealtimeClient().sendTyping(conversationId, true);
      else clearTimeout(timers);
      typingTimers.set(
        conversationId,
        setTimeout(() => {
          typingTimers.delete(conversationId);
          getRealtimeClient().sendTyping(conversationId, false);
        }, TYPING_STOP_AFTER_MS),
      );
      return;
    }
    const timers = typingTimers.get(conversationId);
    if (timers) clearTimeout(timers);
    typingTimers.delete(conversationId);
    getRealtimeClient().sendTyping(conversationId, false);
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
}));

/**
 * Receipts messages the peer sent to a conversation the user is not currently
 * looking at, so the sender still sees them as delivered.
 */
async function acknowledgePeerMessages(conversationId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  try {
    await api.messages.markDelivered(conversationId, {
      messageIds: messageIds.slice(0, 100),
      state: 'delivered',
    });
  } catch {
    // Delivery receipts are best effort; the sender's view stays at "sent".
  }
}

/** Auto-stop timers for our own typing indicator, per conversation. */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** How long the peer keeps showing "typing…" after our last keystroke. */
const TYPING_STOP_AFTER_MS = 2_500;
/** Peer indicators are cleared after this long even if the stop event is lost. */
const PEER_TYPING_TTL_MS = 4_000;
const peerTypingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function optimisticMessage(
  conversationId: string,
  text: string,
  clientMessageId: string,
  replyToId?: string,
): MessageForUser {
  const now = new Date().toISOString();
  return {
    // The optimistic id *is* the client id: `sameMessage()` in message-sync
    // uses that to reconcile it with the canonical record later.
    id: clientMessageId,
    conversationId,
    senderId: useAuthStore.getState().user?.id ?? 'me',
    type: 'text',
    text,
    media: null,
    call: null,
    replyTo: replyToId
      ? { messageId: replyToId, senderId: '', type: 'text', preview: '', createdAt: now }
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
    clientMessageId,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

type SetState = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;

/**
 * Live updates for one conversation.
 *
 * The transport (WebSocket or SSE) is chosen by the realtime client; this only
 * maps events onto the store. Every mutation goes through `message-sync`, so an
 * event that arrives before the REST response — or twice, or after a
 * reconnect — merges into the existing row instead of adding a second bubble.
 */
function subscribe(conversationId: string, set: SetState): void {
  // One subscription per conversation: re-opening must not add a second
  // listener, which is how duplicate messages used to appear.
  streams.get(conversationId)?.();

  const handle = (event: RealtimeEventFrame) => {
    if (!rememberEvent(conversationId, event.id)) return;
    apply(conversationId, event, set);
  };

  const disconnect = getRealtimeClient().subscribeConversation(conversationId, handle);
  streams.set(conversationId, disconnect);
}

function apply(conversationId: string, event: RealtimeEventFrame, set: SetState): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'message.created': {
      const message = payload.message as MessageForUser | undefined;
      if (!message) return;
      set((state) => withMessages(state, conversationId, (list) => upsertMessage(list, message)));
      // Only react to messages the peer sent; our own copy already came back
      // from the REST response.
      const myId = useAuthStore.getState().user?.id ?? null;
      if (myId && message.senderId !== myId) {
        const isActive = useChatStore.getState().activeConversationId === conversationId;
        if (isActive) {
          void useChatStore.getState().acknowledgeDelivery(conversationId);
          void useChatStore.getState().markRead(conversationId);
        } else {
          // Arrived while the user is somewhere else: receipt it anyway (the
          // sender deserves their ✓✓) and show the unread badge immediately.
          void acknowledgePeerMessages(conversationId, [message.id]);
          set((state) => ({
            conversations: state.conversations.map((item) =>
              item.conversation.id === conversationId
                ? { ...item, unreadCount: item.unreadCount + 1 }
                : item,
            ),
          }));
        }
      }
      return;
    }
    case 'message.retracted': {
      // The server already delivered this message but its storage failed, so
      // it is taken back. Recipients lose the bubble entirely; the sender
      // keeps it in a failed state so they can retry.
      const messageId = payload.messageId as string | undefined;
      const clientMessageId = (payload.clientMessageId as string | undefined) ?? null;
      const senderId = payload.senderId as string | undefined;
      const myId = useAuthStore.getState().user?.id ?? null;
      const mine = Boolean(myId && senderId && myId === senderId);
      set((state) =>
        withMessages(state, conversationId, (list) => {
          const isTarget = (message: MessageForUser): boolean =>
            Boolean((messageId && message.id === messageId) ||
              (clientMessageId && message.clientMessageId === clientMessageId));
          if (!list.some(isTarget)) return list;
          if (mine) {
            return list.map((message) =>
              isTarget(message) ? { ...message, deliveryState: 'failed' as const } : message,
            );
          }
          return list.filter((message) => !isTarget(message));
        }),
      );
      if (mine && clientMessageId) {
        set((state) => ({
          pendingClientIds: {
            ...state.pendingClientIds,
            [conversationId]: (state.pendingClientIds[conversationId] ?? []).filter(
              (id) => id !== clientMessageId,
            ),
          },
        }));
        useUiStore
          .getState()
          .pushToast('A message could not be saved on the server — it is marked for retry.', 'error');
      }
      return;
    }
    case 'conversation.updated': {
      const conversation = payload.conversation as ConversationView | undefined;
      if (!conversation) return;
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation) }));
      return;
    }
    case 'message.updated': {
      const message = payload.message as MessageForUser | undefined;
      if (!message) return;
      set((state) => withMessages(state, conversationId, (list) => upsertMessage(list, message)));
      return;
    }
    case 'message.deleted': {
      const messageId = payload.messageId as string | undefined;
      if (!messageId) return;
      set((state) =>
        withMessages(state, conversationId, (list) =>
          list.map((message) =>
            message.id === messageId ? { ...message, deleted: true, text: null, media: null } : message,
          ),
        ),
      );
      return;
    }
    case 'message.delivered':
    case 'message.read':
    case 'message.delivery': {
      const messageIds = (payload.messageIds as string[] | undefined) ?? [];
      const state = (payload.state as 'delivered' | 'read' | undefined) ??
        (event.type === 'message.read' ? 'read' : 'delivered');
      set((current) => withMessages(current, conversationId, (list) => applyDelivery(list, messageIds, state)));
      return;
    }
    case 'typing': {
      const isTyping = Boolean(payload.isTyping);
      set({ typingPeer: { ...useChatStore.getState().typingPeer, [conversationId]: isTyping } });
      // Stale-indicator guard: if the stop frame is lost, clear it anyway.
      const existing = peerTypingTimers.get(conversationId);
      if (existing) clearTimeout(existing);
      if (isTyping) {
        peerTypingTimers.set(
          conversationId,
          setTimeout(() => {
            peerTypingTimers.delete(conversationId);
            set({ typingPeer: { ...useChatStore.getState().typingPeer, [conversationId]: false } });
          }, PEER_TYPING_TTL_MS),
        );
      } else {
        peerTypingTimers.delete(conversationId);
      }
      return;
    }
    case 'media.viewed': {
      // Refresh the conversation so the sender sees the view status.
      void useChatStore.getState().loadConversations();
      return;
    }
    case 'conversation.read': {
      void useChatStore.getState().loadConversations();
      return;
    }
    default:
      return;
  }
}

/**
 * Stops every stream and clears ephemeral state — used by the privacy lock so
 * nothing keeps updating (or stays on screen) once the chat is hidden.
 */
export function disconnectAllStreams(): void {
  for (const disconnect of streams.values()) disconnect();
  streams.clear();
  for (const timer of typingTimers.values()) clearTimeout(timer);
  typingTimers.clear();
  for (const timer of peerTypingTimers.values()) clearTimeout(timer);
  peerTypingTimers.clear();
  seenEvents.clear();
  useChatStore.setState({ typingPeer: {}, activeConversationId: null, activeConversation: null });
  useRealtimeStore.getState().stop();
}

/** Test helper. */
export function resetChatStore(): void {
  disconnectAllStreams();
  useChatStore.setState({
    conversations: [],
    loadingConversations: false,
    messages: {},
    hasMore: {},
    oldestAt: {},
    pendingClientIds: {},
    iceServers: [],
  });
}

export { dedupeMessages, sortByTime };

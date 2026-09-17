import { create } from 'zustand';
import type {
  ConversationView,
  IceServer,
  MessageForUser,
  UserSearchResult,
} from '@mt/types';
import { newId } from '@mt/utils';
import { api } from '@/lib/client/api';
import { connectEventStream } from '@/lib/browser/sse-client';
import { useUiStore } from './ui-store';
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
  sending: boolean;
  iceServers: IceServer[];

  loadConversations: () => Promise<void>;
  createConversation: (participantId: string) => Promise<string | null>;
  openConversation: (conversationId: string) => Promise<void>;
  leaveConversation: () => void;
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
  retry: (conversationId: string, clientMessageId: string, text: string) => Promise<void>;
  markRead: (conversationId: string) => Promise<void>;
  setTyping: (conversationId: string, isTyping: boolean) => void;
  searchUsers: (q: string) => Promise<UserSearchResult[]>;
  hideConversation: (conversationId: string) => Promise<void>;
}

/** Active streams, kept outside the store so they survive re-renders. */
const streams = new Map<string, () => void>();

function upsertMessage(list: MessageForUser[], message: MessageForUser): MessageForUser[] {
  const index = list.findIndex((item) => item.id === message.id);
  if (index === -1) return [...list, message];
  const next = [...list];
  next[index] = { ...next[index], ...message };
  return next;
}

function sortByTime(list: MessageForUser[]): MessageForUser[] {
  return [...list].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
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
      set((state) => ({
        conversations: [conversation, ...state.conversations.filter((item) => item.conversation.id !== conversation.conversation.id)],
      }));
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
        messages: { ...state.messages, [conversationId]: sortByTime(page.items) },
        hasMore: { ...state.hasMore, [conversationId]: page.hasMore },
        oldestAt: { ...state.oldestAt, [conversationId]: page.items[0]?.createdAt ?? null },
      }));
      subscribe(conversationId, set);
      void get().markRead(conversationId);
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  leaveConversation() {
    const id = get().activeConversationId;
    if (id) streams.get(id)?.();
    set({ activeConversationId: null, activeConversation: null, typingPeer: {} });
  },

  async loadOlderMessages(conversationId) {
    const before = get().oldestAt[conversationId];
    if (!before || !get().hasMore[conversationId]) return;
    const page = await api.messages.list(conversationId, { limit: 30, before });
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: sortByTime([...page.items, ...(state.messages[conversationId] ?? [])]),
      },
      hasMore: { ...state.hasMore, [conversationId]: page.hasMore },
      oldestAt: { ...state.oldestAt, [conversationId]: page.items[0]?.createdAt ?? before },
    }));
  },

  async sendText(conversationId, text, replyToId) {
    const clientMessageId = newId('cmsg');
    const optimistic = optimisticMessage(conversationId, text, clientMessageId, replyToId);
    set((state) => ({
      sending: true,
      messages: {
        ...state.messages,
        [conversationId]: sortByTime([...(state.messages[conversationId] ?? []), optimistic]),
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
        sending: false,
        messages: {
          ...state.messages,
          [conversationId]: replaceOptimistic(state.messages[conversationId] ?? [], clientMessageId, result.message),
        },
        conversations: upsertConversation(state.conversations, result.conversation),
      }));
    } catch (error) {
      set((state) => ({
        sending: false,
        messages: {
          ...state.messages,
          [conversationId]: markFailed(state.messages[conversationId] ?? [], clientMessageId),
        },
      }));
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async sendMedia({ conversationId, mediaId, type, caption, viewOnce }) {
    const clientMessageId = newId('cmsg');
    set({ sending: true });
    try {
      const result = await api.media.send({ conversationId, mediaId, type, caption, clientMessageId, viewOnce });
      set((state) => ({
        sending: false,
        messages: {
          ...state.messages,
          [conversationId]: sortByTime([...(state.messages[conversationId] ?? []), result.message]),
        },
        conversations: upsertConversation(state.conversations, result.conversation),
      }));
    } catch (error) {
      set({ sending: false });
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async editMessage(messageId, text) {
    try {
      const result = await api.messages.edit(messageId, { text });
      set((state) => {
        const conversationId = result.message.conversationId;
        return {
          messages: {
            ...state.messages,
            [conversationId]: upsertMessage(state.messages[conversationId] ?? [], result.message),
          },
        };
      });
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async deleteMessage(messageId, scope) {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    if (scope === 'me') {
      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId]: (state.messages[conversationId] ?? []).filter((message) => message.id !== messageId),
        },
      }));
    }
    try {
      await api.messages.remove(messageId, { scope });
      if (scope === 'everyone') {
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: (state.messages[conversationId] ?? []).map((message) =>
              message.id === messageId ? { ...message, deleted: true, text: null } : message,
            ),
          },
        }));
      }
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async retry(conversationId, clientMessageId, text) {
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] ?? []).filter(
          (message) => message.clientMessageId !== clientMessageId,
        ),
      },
    }));
    await get().sendText(conversationId, text);
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

  setTyping(conversationId, isTyping) {
    void api.conversations.typing(conversationId, isTyping).catch(() => undefined);
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

function optimisticMessage(
  conversationId: string,
  text: string,
  clientMessageId: string,
  replyToId?: string,
): MessageForUser {
  const now = new Date().toISOString();
  return {
    id: clientMessageId,
    conversationId,
    senderId: 'me',
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
    createdAt: now,
    updatedAt: now,
  };
}

function replaceOptimistic(
  list: MessageForUser[],
  clientMessageId: string,
  message: MessageForUser,
): MessageForUser[] {
  return sortByTime(
    list.map((item) => (item.clientMessageId === clientMessageId ? message : item)),
  ).filter(
    (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
  );
}

function markFailed(list: MessageForUser[], clientMessageId: string): MessageForUser[] {
  return list.map((item) =>
    item.clientMessageId === clientMessageId ? { ...item, deliveryState: 'failed' } : item,
  );
}

function upsertConversation(list: ConversationView[], conversation: ConversationView): ConversationView[] {
  const exists = list.some((item) => item.conversation.id === conversation.conversation.id);
  if (!exists) return [conversation, ...list];
  return list.map((item) => (item.conversation.id === conversation.conversation.id ? conversation : item));
}

type SetState = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;

/**
 * Live updates for one conversation over SSE: new/edited/deleted messages,
 * delivery + read receipts, typing indicators and media-view notifications.
 */
function subscribe(conversationId: string, set: SetState): void {
  streams.get(conversationId)?.();
  const disconnect = connectEventStream({
    url: `/api/v1/conversations/${conversationId}/events`,
    events: {
      'message.created': (payload) => {
        const message = (payload as { message: MessageForUser }).message;
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: upsertMessage(state.messages[conversationId] ?? [], message),
          },
        }));
        void useChatStore.getState().markRead(conversationId);
      },
      'message.updated': (payload) => {
        const message = (payload as { message: MessageForUser }).message;
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: upsertMessage(state.messages[conversationId] ?? [], message),
          },
        }));
      },
      'message.deleted': (payload) => {
        const { messageId } = payload as { messageId: string };
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: (state.messages[conversationId] ?? []).map((message) =>
              message.id === messageId ? { ...message, deleted: true, text: null, media: null } : message,
            ),
          },
        }));
      },
      'message.delivery': (payload) => {
        const { messageIds, state: deliveryState } = payload as { messageIds: string[]; state: 'delivered' | 'read' };
        set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: (state.messages[conversationId] ?? []).map((message) =>
              messageIds.includes(message.id) ? { ...message, deliveryState } : message,
            ),
          },
        }));
      },
      typing: (payload) => {
        const { isTyping } = payload as { isTyping: boolean };
        set((state) => ({ typingPeer: { ...state.typingPeer, [conversationId]: isTyping } }));
      },
      'media.viewed': () => {
        void useChatStore.getState().openConversation(conversationId);
      },
      'conversation.read': () => {
        void useChatStore.getState().loadConversations();
      },
    },
  });
  streams.set(conversationId, disconnect);
}

/** Stops every stream — used by the privacy lock so nothing keeps updating. */
export function disconnectAllStreams(): void {
  for (const disconnect of streams.values()) disconnect();
  streams.clear();
}

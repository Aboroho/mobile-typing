/**
 * @vitest-environment jsdom
 *
 * Chat store synchronisation. The API is stubbed at the `fetch` boundary and
 * the realtime transport at the module boundary; everything under test — the
 * store, `lib/client/message-sync` and the typed API client — is the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationView, MessageForUser, Timestamp } from '@mt/types';
import { setAuthTokenProvider } from '@/lib/client/api';
import { resetChatStore, useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { useUiStore } from '@/stores/ui-store';

vi.mock('@/lib/browser/realtime-client', () => {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const sent: Array<{ conversationId: string; isTyping: boolean }> = [];
  let subscribeCount = 0;

  const client = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: () => 'websocket' as const,
    getLastEventId: () => null,
    onStatus: () => () => undefined,
    sendTyping: (conversationId: string, isTyping: boolean) => sent.push({ conversationId, isTyping }),
    unsubscribeConversation: (conversationId: string) => handlers.delete(conversationId),
    subscribeConversation: (conversationId: string, handler: (event: unknown) => void) => {
      subscribeCount += 1;
      const set = handlers.get(conversationId) ?? new Set();
      set.add(handler);
      handlers.set(conversationId, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(conversationId);
      };
    },
  };

  return {
    getRealtimeClient: () => client,
    createRealtimeClient: () => client,
    resetRealtimeClient: () => undefined,
    __test: {
      handlers,
      sent,
      subscribeCount: () => subscribeCount,
      emit(conversationId: string, event: unknown) {
        for (const handler of handlers.get(conversationId) ?? []) handler(event);
      },
      reset() {
        handlers.clear();
        sent.length = 0;
        subscribeCount = 0;
      },
    },
  };
});

const { __test: realtime } = await import('@/lib/browser/realtime-client') as unknown as {
  __test: {
    handlers: Map<string, Set<(event: unknown) => void>>;
    sent: Array<{ conversationId: string; isTyping: boolean }>;
    subscribeCount: () => number;
    emit(conversationId: string, event: unknown): void;
    reset(): void;
  };
};

const CID = 'conv_1';
const ME = 'u_me';
const PEER = 'u_peer';

let serverMessages: MessageForUser[] = [];
let requestLog: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
let sendShouldFail = false;
let sendDelayMs = 0;

function iso(offset = 0): Timestamp {
  return new Date(1_700_000_000_000 + offset).toISOString() as Timestamp;
}

function serverMessage(id: string, overrides: Partial<MessageForUser> = {}): MessageForUser {
  return {
    id,
    conversationId: CID,
    senderId: ME,
    type: 'text',
    text: `text ${id}`,
    media: null,
    call: null,
    replyTo: null,
    deliveryState: 'sent',
    deliveredAt: null,
    readBy: [],
    readAt: null,
    edited: false,
    editedAt: null,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    clientMessageId: null,
    expiresAt: null,
    createdAt: iso(1000),
    updatedAt: iso(1000),
    ...overrides,
  } as MessageForUser;
}

function conversationView(): ConversationView {
  return {
    conversation: {
      id: CID,
      participantIds: [ME, PEER],
      lastMessage: null,
      lastMessageAt: null,
      lastActivityAt: iso(),
      createdAt: iso(),
    },
    otherUser: { id: PEER, name: 'Peer', photoUrl: null, presence: 'online' },
    unreadCount: 0,
    hidden: false,
    blockedUserIds: [],
  } as unknown as ConversationView;
}

function respond(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requestLog.push({ path: url.pathname, method: init?.method ?? 'GET', body });

      if (init?.method === 'POST' && url.pathname === '/api/v1/messages') {
        if (sendDelayMs > 0) await new Promise((r) => setTimeout(r, sendDelayMs));
        if (sendShouldFail) {
          return respond(500, { ok: false, error: { code: 'INTERNAL', message: 'database unavailable' } });
        }
        const clientMessageId = String(body['clientMessageId'] ?? '');
        // Server-side idempotency: the same clientMessageId returns the same row.
        const existing = serverMessages.find((m) => m.clientMessageId === clientMessageId);
        if (existing) return respond(201, { ok: true, data: { message: existing, conversation: conversationView() } });
        const created = serverMessage(`m_${serverMessages.length + 1}`, {
          clientMessageId,
          text: String(body['text'] ?? ''),
        });
        serverMessages.push(created);
        return respond(201, { ok: true, data: { message: created, conversation: conversationView() } });
      }

      if (url.pathname === `/api/v1/conversations/${CID}/messages` && (init?.method ?? 'GET') === 'GET') {
        return respond(200, { ok: true, data: { items: serverMessages, nextCursor: null, hasMore: false } });
      }

      if (url.pathname === '/api/v1/conversations' && (init?.method ?? 'GET') === 'GET') {
        return respond(200, {
          ok: true,
          data: { items: [conversationView()], nextCursor: null, hasMore: false },
        });
      }

      if (url.pathname === `/api/v1/conversations/${CID}` && (init?.method ?? 'GET') === 'GET') {
        return respond(200, { ok: true, data: { conversation: conversationView(), iceServers: [], activeCall: null } });
      }

      if (url.pathname.endsWith('/messages/delivery')) {
        return respond(200, { ok: true, data: { updated: (body['messageIds'] as string[]).length } });
      }
      if (url.pathname.endsWith('/read')) return respond(200, { ok: true, data: { ok: true } });
      if (url.pathname.endsWith('/typing')) return respond(200, { ok: true, data: { ok: true } });

      return respond(404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
    }),
  );
}

describe('chat store message synchronisation', () => {
  beforeEach(() => {
    realtime.reset();
    serverMessages = [];
    requestLog = [];
    sendShouldFail = false;
    sendDelayMs = 0;
    installFetch();
    setAuthTokenProvider(async () => null);
    useAuthStore.setState({ user: { id: ME } as never, initializing: false, error: null, pending: false });
    useUiStore.setState({ toasts: [] });
    resetChatStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetChatStore();
  });

  it('shows one bubble when the optimistic message is reconciled with the REST response', async () => {
    await useChatStore.getState().openConversation(CID);
    await useChatStore.getState().sendText(CID, 'hello');

    const list = useChatStore.getState().messages[CID] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('m_1');
    expect(list[0]?.deliveryState).toBe('sent');
  });

  it('shows one bubble when a realtime event for our own message arrives', async () => {
    await useChatStore.getState().openConversation(CID);
    await useChatStore.getState().sendText(CID, 'hello');
    const canonical = serverMessages[0]!;

    realtime.emit(CID, {
      id: 'evt_1',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: { conversationId: CID, message: canonical, forUserId: ME },
    });

    expect(useChatStore.getState().messages[CID]).toHaveLength(1);
  });

  it('shows one bubble when the realtime event wins the race against the REST response', async () => {
    await useChatStore.getState().openConversation(CID);
    sendDelayMs = 20;
    const pending = useChatStore.getState().sendText(CID, 'racing');

    // Wait until the optimistic row exists, then deliver the server copy first.
    await vi.waitFor(() => expect((useChatStore.getState().messages[CID] ?? []).length).toBe(1));
    const optimisticId = (useChatStore.getState().messages[CID] ?? [])[0]!.clientMessageId!;
    realtime.emit(CID, {
      id: 'evt_2',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: {
        conversationId: CID,
        message: serverMessage('m_race', { clientMessageId: optimisticId, text: 'racing' }),
        forUserId: ME,
      },
    });

    await pending;
    const list = useChatStore.getState().messages[CID] ?? [];
    expect(list).toHaveLength(1);
  });

  it('applies the same realtime event twice without duplicating', async () => {
    await useChatStore.getState().openConversation(CID);
    const frame = {
      id: 'evt_dup',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: {
        conversationId: CID,
        message: serverMessage('m_dup', { senderId: PEER, text: 'hi' }),
        forUserId: ME,
      },
    };
    realtime.emit(CID, frame);
    realtime.emit(CID, frame);
    expect(useChatStore.getState().messages[CID]).toHaveLength(1);
  });

  it('marks a failed send and retries with the same clientMessageId', async () => {
    await useChatStore.getState().openConversation(CID);
    sendShouldFail = true;
    await useChatStore.getState().sendText(CID, 'will fail');

    let list = useChatStore.getState().messages[CID] ?? [];
    expect(list[0]?.deliveryState).toBe('failed');
    const clientMessageId = list[0]!.clientMessageId!;

    sendShouldFail = false;
    await useChatStore.getState().retry(CID, clientMessageId, 'will fail');

    list = useChatStore.getState().messages[CID] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.deliveryState).toBe('sent');

    const sends = requestLog.filter((r) => r.path === '/api/v1/messages');
    expect(sends).toHaveLength(2);
    expect(sends[0]?.body['clientMessageId']).toBe(sends[1]?.body['clientMessageId']);
  });

  it('acknowledges delivery for messages the peer sent', async () => {
    await useChatStore.getState().openConversation(CID);
    realtime.emit(CID, {
      id: 'evt_peer',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: {
        conversationId: CID,
        message: serverMessage('m_peer', { senderId: PEER, text: 'from peer' }),
        forUserId: ME,
      },
    });
    await vi.waitFor(() =>
      expect(requestLog.some((r) => r.path.endsWith('/messages/delivery') && r.body['state'] === 'delivered')).toBe(true),
    );
    // Our own messages are never receipted by us.
    const ids = requestLog
      .filter((r) => r.path.endsWith('/messages/delivery'))
      .flatMap((r) => r.body['messageIds'] as string[]);
    expect(ids).toEqual(['m_peer']);
  });

  it('updates the sender view when a read receipt arrives', async () => {
    await useChatStore.getState().openConversation(CID);
    await useChatStore.getState().sendText(CID, 'hello');

    realtime.emit(CID, {
      id: 'evt_delivered',
      topic: `conversation:${CID}:messages`,
      type: 'message.delivered',
      payload: { conversationId: CID, messageIds: ['m_1'], state: 'delivered', otherUserId: ME },
    });
    expect((useChatStore.getState().messages[CID] ?? [])[0]?.deliveryState).toBe('delivered');

    realtime.emit(CID, {
      id: 'evt_read',
      topic: `conversation:${CID}:messages`,
      type: 'message.read',
      payload: { conversationId: CID, messageIds: ['m_1'], state: 'read', otherUserId: ME },
    });
    expect((useChatStore.getState().messages[CID] ?? [])[0]?.deliveryState).toBe('read');
  });

  it('does not let a late delivered frame downgrade a read receipt', async () => {
    await useChatStore.getState().openConversation(CID);
    await useChatStore.getState().sendText(CID, 'hello');
    realtime.emit(CID, {
      id: 'evt_r',
      topic: `conversation:${CID}:messages`,
      type: 'message.read',
      payload: { conversationId: CID, messageIds: ['m_1'], state: 'read' },
    });
    realtime.emit(CID, {
      id: 'evt_d',
      topic: `conversation:${CID}:messages`,
      type: 'message.delivered',
      payload: { conversationId: CID, messageIds: ['m_1'], state: 'delivered' },
    });
    expect((useChatStore.getState().messages[CID] ?? [])[0]?.deliveryState).toBe('read');
  });

  it('keeps rapid consecutive messages distinct', async () => {
    await useChatStore.getState().openConversation(CID);
    await Promise.all([
      useChatStore.getState().sendText(CID, 'one'),
      useChatStore.getState().sendText(CID, 'two'),
      useChatStore.getState().sendText(CID, 'three'),
    ]);
    const list = useChatStore.getState().messages[CID] ?? [];
    expect(list).toHaveLength(3);
    expect(new Set(list.map((m) => m.id)).size).toBe(3);
  });

  it('merges a paginated fetch with live messages without duplicates', async () => {
    serverMessages = [serverMessage('m_old', { senderId: PEER, createdAt: iso(0) })];
    await useChatStore.getState().openConversation(CID);

    realtime.emit(CID, {
      id: 'evt_live',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: {
        conversationId: CID,
        message: serverMessage('m_live', { senderId: PEER, createdAt: iso(5000) }),
        forUserId: ME,
      },
    });
    // Re-opening replays the page that now contains both messages.
    await useChatStore.getState().openConversation(CID);

    const list = useChatStore.getState().messages[CID] ?? [];
    expect(list.map((m) => m.id).sort()).toEqual(['m_live', 'm_old']);
  });

  it('subscribes once per conversation, even when it is opened repeatedly', async () => {
    await useChatStore.getState().openConversation(CID);
    await useChatStore.getState().openConversation(CID);
    await useChatStore.getState().openConversation(CID);
    expect(realtime.handlers.get(CID)?.size).toBe(1);
  });

  it('typing goes out once and is stopped automatically', async () => {
    vi.useFakeTimers();
    try {
      await useChatStore.getState().openConversation(CID);
      useChatStore.getState().setTyping(CID, true);
      useChatStore.getState().setTyping(CID, true);
      useChatStore.getState().setTyping(CID, true);
      expect(realtime.sent.filter((s) => s.isTyping)).toHaveLength(1);

      vi.advanceTimersByTime(2_600);
      expect(realtime.sent.some((s) => !s.isTyping)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops typing when the conversation is left', async () => {
    await useChatStore.getState().openConversation(CID);
    useChatStore.getState().setTyping(CID, true);
    useChatStore.getState().leaveConversation();
    expect(realtime.sent.some((s) => !s.isTyping)).toBe(true);
  });
});

describe('retraction and live conversation updates', () => {
  beforeEach(() => {
    realtime.reset();
    serverMessages = [];
    requestLog = [];
    sendShouldFail = false;
    sendDelayMs = 0;
    installFetch();
    setAuthTokenProvider(async () => null);
    useAuthStore.setState({ user: { id: ME } as never, initializing: false, error: null, pending: false });
    useUiStore.setState({ toasts: [] });
    resetChatStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetChatStore();
  });

  it('marks our own message failed when the server retracts it', async () => {
    await useChatStore.getState().openConversation(CID);
    await useChatStore.getState().sendText(CID, 'will be retracted');
    const sent = (useChatStore.getState().messages[CID] ?? [])[0]!;
    expect(sent.deliveryState).toBe('sent');

    realtime.emit(CID, {
      id: 'evt_retract_1',
      topic: `conversation:${CID}:messages`,
      type: 'message.retracted',
      payload: {
        conversationId: CID,
        messageId: sent.id,
        clientMessageId: sent.clientMessageId,
        senderId: ME,
        reason: 'storage_failed',
        forUserId: ME,
      },
    });

    const list = useChatStore.getState().messages[CID] ?? [];
    // Kept on screen so it can be retried — never silently dropped.
    expect(list).toHaveLength(1);
    expect(list[0]?.deliveryState).toBe('failed');
    expect(list[0]?.text).toBe('will be retracted');
    expect(useUiStore.getState().toasts.length).toBeGreaterThan(0);
  });

  it('removes the peer message when the server retracts it', async () => {
    await useChatStore.getState().openConversation(CID);
    realtime.emit(CID, {
      id: 'evt_peer_retracted',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: {
        conversationId: CID,
        message: serverMessage('m_ghost', { senderId: PEER, text: 'boo' }),
        forUserId: ME,
      },
    });
    expect(useChatStore.getState().messages[CID]).toHaveLength(1);

    realtime.emit(CID, {
      id: 'evt_retract_2',
      topic: `conversation:${CID}:messages`,
      type: 'message.retracted',
      payload: {
        conversationId: CID,
        messageId: 'm_ghost',
        clientMessageId: null,
        senderId: PEER,
        reason: 'storage_failed',
        forUserId: ME,
      },
    });
    expect(useChatStore.getState().messages[CID]).toHaveLength(0);
  });

  it('updates the conversation list live from conversation.updated', async () => {
    await useChatStore.getState().loadConversations();
    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(useChatStore.getState().conversations[0]?.conversation.lastMessage).toBeNull();

    const updated = conversationView();
    updated.conversation.lastMessage = {
      messageId: 'm_9',
      text: 'fresh preview',
      kind: 'text',
      createdAt: iso(9000),
    } as never;
    updated.unreadCount = 3;

    realtime.emit(CID, {
      id: 'evt_conv',
      topic: `conversation:${CID}`,
      type: 'conversation.updated',
      payload: { conversationId: CID, conversation: updated, forUserId: ME },
    });

    const list = useChatStore.getState().conversations;
    expect(list[0]?.conversation.lastMessage).toMatchObject({ text: 'fresh preview' });
    expect(list[0]?.unreadCount).toBe(3);
  });

  it('keeps delivering to conversations the user is not looking at', async () => {
    await useChatStore.getState().loadConversations();
    // Not opened: the user is on the conversation list.

    realtime.emit(CID, {
      id: 'evt_background',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: {
        conversationId: CID,
        message: serverMessage('m_bg', { senderId: PEER, text: 'anyone there?' }),
        forUserId: ME,
      },
    });

    // The unread badge shows immediately…
    expect(useChatStore.getState().conversations[0]?.unreadCount).toBe(1);
    // …the peer message is still receipted so the sender sees ✓✓…
    await vi.waitFor(() =>
      expect(
        requestLog.some((r) => r.path.endsWith('/messages/delivery') && r.body['state'] === 'delivered'),
      ).toBe(true),
    );
    // …and the message waits for when the conversation is opened.
    expect((useChatStore.getState().messages[CID] ?? []).map((m) => m.id)).toContain('m_bg');
  });

  it('stays subscribed after leaving a conversation', async () => {
    await useChatStore.getState().openConversation(CID);
    useChatStore.getState().leaveConversation();

    realtime.emit(CID, {
      id: 'evt_after_leave',
      topic: `conversation:${CID}:messages`,
      type: 'message.created',
      payload: {
        conversationId: CID,
        message: serverMessage('m_late', { senderId: PEER, text: 'still arrives' }),
        forUserId: ME,
      },
    });
    expect((useChatStore.getState().messages[CID] ?? []).map((m) => m.id)).toContain('m_late');
  });
});

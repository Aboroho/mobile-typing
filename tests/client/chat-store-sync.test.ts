/**
 * @vitest-environment jsdom
 *
 * Integration test for the chat store's synchronisation: the real store code
 * with a scripted API and a scripted event stream, exercising the exact race
 * that produced the duplicate-message bug (stream event before HTTP response)
 * and the surrounding scenarios (retry, reconnect, pagination, two tabs,
 * receipts, typing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_PAGE_SIZE, type MessageForUser } from '@mt/types';

// --- Scripted API ------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ME = 'u_me';
const PEER = 'u_peer';
const CONVERSATION = 'c_1';

let serverMessages: MessageForUser[] = [];
let serverIdCounter = 0;
/** Pending POST /messages calls, resolved manually by the test. */
let sendCalls: Array<{ input: { clientMessageId: string; text?: string }; done: Deferred<{ message: MessageForUser; conversation: unknown }> }> = [];
let deliveredCalls: Array<{ messageIds: string[]; state: string }> = [];
let readCalls: Array<{ lastReadMessageAt: string }> = [];
let typingCalls: boolean[] = [];
let listCalls: Array<{ before?: string; after?: string; limit?: number }> = [];

function serverMessage(overrides: Partial<MessageForUser> & { senderId: string; text: string }): MessageForUser {
  serverIdCounter += 1;
  const createdAt = overrides.createdAt ?? new Date(Date.UTC(2026, 0, 1, 10, 0, serverIdCounter)).toISOString();
  return {
    id: `m_${serverIdCounter}`,
    conversationId: CONVERSATION,
    type: 'text',
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
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const conversationView = {
  conversation: { id: CONVERSATION, participantIds: [ME, PEER], participants: {} },
  otherUser: { id: PEER, name: 'Peer', photoUrl: null, presence: 'online' },
  unreadCount: 0,
  hidden: false,
  isTyping: false,
};

vi.mock('@/lib/client/api', () => ({
  api: {
    conversations: {
      get: vi.fn(async () => ({ conversation: conversationView, iceServers: [] })),
      list: vi.fn(async () => ({ items: [conversationView], hasMore: false })),
      markRead: vi.fn(async (_id: string, input: { lastReadMessageAt: string }) => {
        readCalls.push(input);
        return { ok: true, updated: 1, messageIds: [] };
      }),
      typing: vi.fn(async (_id: string, isTyping: boolean) => {
        typingCalls.push(isTyping);
        return { ok: true };
      }),
    },
    messages: {
      list: vi.fn(async (_id: string, params: { before?: string; after?: string; limit?: number } = {}) => {
        listCalls.push(params);
        const sorted = [...serverMessages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        let items = sorted;
        if (params.before) items = items.filter((item) => item.createdAt < params.before!);
        if (params.after) items = items.filter((item) => item.createdAt > params.after!);
        const limit = params.limit ?? MESSAGE_PAGE_SIZE;
        const page = params.after ? items.slice(0, limit) : items.slice(-limit);
        return { items: page, hasMore: items.length > page.length, nextCursor: null };
      }),
      send: vi.fn((input: { clientMessageId: string; text?: string }) => {
        const done = deferred<{ message: MessageForUser; conversation: unknown }>();
        sendCalls.push({ input, done });
        return done.promise;
      }),
      markDelivered: vi.fn(async (_id: string, input: { messageIds: string[]; state: string }) => {
        deliveredCalls.push(input);
        return { updated: input.messageIds.length, messageIds: input.messageIds };
      }),
      edit: vi.fn(),
      remove: vi.fn(),
    },
    media: { send: vi.fn() },
    users: { search: vi.fn(async () => ({ items: [] })) },
  },
}));

// --- Scripted event stream ---------------------------------------------------

type Handlers = Record<string, (payload: unknown) => void>;
let streams: Array<{ url: string; handlers: Handlers; onReady?: () => void; onError?: () => void; closed: boolean }> = [];

vi.mock('@/lib/browser/sse-client', () => ({
  connectEventStream: vi.fn((options: { url: string; events: Handlers; onReady?: () => void; onError?: () => void }) => {
    const stream = { url: options.url, handlers: options.events, onReady: options.onReady, onError: options.onError, closed: false };
    streams.push(stream);
    return () => {
      stream.closed = true;
    };
  }),
}));

function liveStream() {
  const open = streams.filter((stream) => !stream.closed);
  expect(open).toHaveLength(1);
  return open[0]!;
}

/** The server stores the message (assigning id + timestamp in processing order). */
function serverStores(call: (typeof sendCalls)[number]): MessageForUser {
  const existing = serverMessages.find((item) => item.clientMessageId === call.input.clientMessageId);
  if (existing) return existing;
  const stored = serverMessage({ senderId: ME, text: call.input.text ?? '', clientMessageId: call.input.clientMessageId });
  serverMessages.push(stored);
  return stored;
}

/** The server publishes `message.created` to the sender *before* the HTTP response. */
function serverAccepts(call: (typeof sendCalls)[number]): MessageForUser {
  const stored = serverStores(call);
  liveStream().handlers['message.created']!({ message: stored });
  return stored;
}

// --- Store under test ---------------------------------------------------------

import { useChatStore, __resetChatRuntimeForTests } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';

function list(): MessageForUser[] {
  return useChatStore.getState().messages[CONVERSATION] ?? [];
}
const texts = () => list().map((message) => message.text);
const states = () => list().map((message) => message.deliveryState);

beforeEach(async () => {
  vi.useFakeTimers();
  serverMessages = [];
  serverIdCounter = 0;
  sendCalls = [];
  deliveredCalls = [];
  readCalls = [];
  typingCalls = [];
  listCalls = [];
  streams = [];
  __resetChatRuntimeForTests();
  useChatStore.getState().reset();
  useAuthStore.setState({ user: { id: ME, name: 'Me' } as never });
});

afterEach(() => {
  __resetChatRuntimeForTests();
  vi.useRealTimers();
});

async function open() {
  const opening = useChatStore.getState().openConversation(CONVERSATION);
  await vi.advanceTimersByTimeAsync(0);
  await opening;
  liveStream().onReady?.();
}

describe('duplicate message bug (stream event before HTTP response)', () => {
  it('shows the message exactly once at every step of the race', async () => {
    await open();

    const sending = useChatStore.getState().sendText(CONVERSATION, 'hello');
    // Optimistic placeholder, pending.
    expect(texts()).toEqual(['hello']);
    expect(states()).toEqual(['sending']);

    // The server stores the message and publishes to the stream FIRST…
    const stored = serverAccepts(sendCalls[0]!);
    expect(texts()).toEqual(['hello']); // ← this was two rows before the fix
    expect(states()).toEqual(['sent']);
    expect(list()[0]!.id).toBe(stored.id);

    // …and only then answers the POST.
    sendCalls[0]!.done.resolve({ message: stored, conversation: conversationView });
    await sending;
    expect(texts()).toEqual(['hello']);
    expect(list()[0]!.id).toBe(stored.id);
    expect(list()[0]!.clientMessageId).toBe(sendCalls[0]!.input.clientMessageId);
  });

  it('is equally correct when the HTTP response wins the race', async () => {
    await open();
    const sending = useChatStore.getState().sendText(CONVERSATION, 'hello');
    const call = sendCalls[0]!;
    const stored = serverMessage({ senderId: ME, text: 'hello', clientMessageId: call.input.clientMessageId });
    serverMessages.push(stored);
    call.done.resolve({ message: stored, conversation: conversationView });
    await sending;
    // Late stream event for the same message.
    liveStream().handlers['message.created']!({ message: stored });
    liveStream().handlers['message.created']!({ message: stored });
    expect(texts()).toEqual(['hello']);
    expect(states()).toEqual(['sent']);
  });

  it('keeps rapid consecutive messages in order and unique when confirmations arrive out of order', async () => {
    await open();
    const sends = ['a', 'b', 'c'].map((text) => useChatStore.getState().sendText(CONVERSATION, text));
    expect(texts()).toEqual(['a', 'b', 'c']);

    const [a, b, c] = sendCalls;
    // The server processes them in order, but the confirmations (stream
    // frames and responses) reach this tab out of order.
    const storedA = serverStores(a!);
    const storedB = serverStores(b!);
    const storedC = serverStores(c!);
    serverAccepts(c!);
    serverAccepts(a!);
    serverAccepts(b!);
    expect(texts()).toEqual(['a', 'b', 'c']);

    b!.done.resolve({ message: storedB, conversation: conversationView });
    c!.done.resolve({ message: storedC, conversation: conversationView });
    a!.done.resolve({ message: storedA, conversation: conversationView });
    await Promise.all(sends);
    expect(texts()).toEqual(['a', 'b', 'c']);
    expect(list().map((message) => message.id)).toEqual([storedA.id, storedB.id, storedC.id]);
  });
});

describe('failed send and retry', () => {
  it('marks the message failed, retries with the same client id and reconciles once', async () => {
    await open();
    const first = useChatStore.getState().sendText(CONVERSATION, 'flaky');
    sendCalls[0]!.done.reject(new Error('network'));
    await first;
    expect(states()).toEqual(['failed']);
    const clientMessageId = sendCalls[0]!.input.clientMessageId;

    const retrying = useChatStore.getState().retry(CONVERSATION, clientMessageId);
    expect(states()).toEqual(['sending']);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]!.input.clientMessageId).toBe(clientMessageId);

    const stored = serverAccepts(sendCalls[1]!);
    sendCalls[1]!.done.resolve({ message: stored, conversation: conversationView });
    await retrying;
    expect(texts()).toEqual(['flaky']);
    expect(states()).toEqual(['sent']);
  });

  it('does not duplicate when the first attempt actually reached the server', async () => {
    await open();
    const first = useChatStore.getState().sendText(CONVERSATION, 'timeout');
    const call = sendCalls[0]!;
    // Server stored it (and will publish) but the response was lost.
    const stored = serverMessage({ senderId: ME, text: 'timeout', clientMessageId: call.input.clientMessageId });
    serverMessages.push(stored);
    call.done.reject(new Error('timeout'));
    await first;
    expect(states()).toEqual(['failed']);

    // Retry → idempotent server answers with the original message, stream repeats it.
    const retrying = useChatStore.getState().retry(CONVERSATION, call.input.clientMessageId);
    const again = serverAccepts(sendCalls[1]!);
    expect(again.id).toBe(stored.id);
    sendCalls[1]!.done.resolve({ message: stored, conversation: conversationView });
    await retrying;
    expect(texts()).toEqual(['timeout']);
    expect(list()[0]!.id).toBe(stored.id);
  });

  it('ignores a late failure once the stream has confirmed the message', async () => {
    await open();
    const sending = useChatStore.getState().sendText(CONVERSATION, 'late');
    serverAccepts(sendCalls[0]!);
    sendCalls[0]!.done.reject(new Error('socket closed'));
    await sending;
    expect(states()).toEqual(['sent']);
  });

  it('lets the user discard a failed message', async () => {
    await open();
    const sending = useChatStore.getState().sendText(CONVERSATION, 'drop me');
    sendCalls[0]!.done.reject(new Error('offline'));
    await sending;
    useChatStore.getState().discardFailed(CONVERSATION, sendCalls[0]!.input.clientMessageId);
    expect(list()).toEqual([]);
  });
});

describe('incoming messages and receipts', () => {
  it('shows a peer message once and acknowledges delivery in one batched request', async () => {
    await open();
    const one = serverMessage({ senderId: PEER, text: 'hi' });
    const two = serverMessage({ senderId: PEER, text: 'there' });
    serverMessages.push(one, two);
    liveStream().handlers['message.created']!({ message: one });
    liveStream().handlers['message.created']!({ message: two });
    liveStream().handlers['message.created']!({ message: two }); // repeated frame
    expect(texts()).toEqual(['hi', 'there']);

    await vi.advanceTimersByTimeAsync(500);
    expect(deliveredCalls).toEqual([{ messageIds: [one.id, two.id], state: 'delivered' }]);
    expect(states()).toEqual(['delivered', 'delivered']);

    // Nothing is re-sent for messages already acknowledged.
    liveStream().handlers['message.created']!({ message: two });
    await vi.advanceTimersByTimeAsync(500);
    expect(deliveredCalls).toHaveLength(1);
  });

  it('sends one read watermark for a burst of seen messages and never a lower one', async () => {
    await open();
    const one = serverMessage({ senderId: PEER, text: 'a' });
    const two = serverMessage({ senderId: PEER, text: 'b' });
    serverMessages.push(one, two);
    liveStream().handlers['message.created']!({ message: one });
    liveStream().handlers['message.created']!({ message: two });

    useChatStore.getState().reportMessageSeen(CONVERSATION, one);
    useChatStore.getState().reportMessageSeen(CONVERSATION, two);
    await vi.advanceTimersByTimeAsync(500);
    expect(readCalls).toEqual([{ lastReadMessageAt: two.createdAt }]);
    expect(states()).toEqual(['read', 'read']);

    useChatStore.getState().reportMessageSeen(CONVERSATION, one); // scrolled back up
    await vi.advanceTimersByTimeAsync(500);
    expect(readCalls).toHaveLength(1);

    // Own messages never produce a read receipt.
    const mine = serverMessage({ senderId: ME, text: 'me' });
    useChatStore.getState().reportMessageSeen(CONVERSATION, mine);
    await vi.advanceTimersByTimeAsync(500);
    expect(readCalls).toHaveLength(1);
  });

  it('applies the peer receipts to my messages without ever downgrading', async () => {
    await open();
    const sending = useChatStore.getState().sendText(CONVERSATION, 'ping');
    const stored = serverAccepts(sendCalls[0]!);
    sendCalls[0]!.done.resolve({ message: stored, conversation: conversationView });
    await sending;

    const handlers = liveStream().handlers;
    handlers['message.delivery']!({ messageIds: [stored.id], state: 'read', at: '2026-01-01T11:00:00.000Z' });
    expect(states()).toEqual(['read']);
    handlers['message.delivery']!({ messageIds: [stored.id], state: 'delivered' }); // stale
    expect(states()).toEqual(['read']);

    // A watermark from the peer marks everything up to it as read.
    const second = useChatStore.getState().sendText(CONVERSATION, 'pong');
    const stored2 = serverAccepts(sendCalls[1]!);
    sendCalls[1]!.done.resolve({ message: stored2, conversation: conversationView });
    await second;
    handlers['conversation.read']!({ userId: PEER, lastReadMessageAt: stored2.createdAt });
    expect(states()).toEqual(['read', 'read']);
  });
});

describe('reconnect, pagination and multiple tabs', () => {
  it('catches up after a reconnect without duplicating anything', async () => {
    const old = serverMessage({ senderId: PEER, text: 'old' });
    serverMessages.push(old);
    await open();
    expect(texts()).toEqual(['old']);

    // Connection drops; a message arrives while offline; connection returns.
    liveStream().onError?.();
    expect(useChatStore.getState().streamState[CONVERSATION]).toBe('reconnecting');
    const missed = serverMessage({ senderId: PEER, text: 'missed' });
    serverMessages.push(missed);
    liveStream().onReady?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(['old', 'missed']);
    expect(useChatStore.getState().streamState[CONVERSATION]).toBe('live');

    // The stream then replays the message it had buffered.
    liveStream().handlers['message.created']!({ message: missed });
    expect(texts()).toEqual(['old', 'missed']);
  });

  it('keeps a pending message when the catch-up fetch returns', async () => {
    await open();
    void useChatStore.getState().sendText(CONVERSATION, 'unsent');
    liveStream().onError?.();
    liveStream().onReady?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(['unsent']);
    expect(states()).toEqual(['sending']);
  });

  it('prepends an older page without touching newer messages', async () => {
    const total = MESSAGE_PAGE_SIZE + 10;
    for (let index = 0; index < total; index += 1) serverMessages.push(serverMessage({ senderId: PEER, text: `m${index}` }));
    await open();
    expect(list()).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(useChatStore.getState().hasMore[CONVERSATION]).toBe(true);

    // A live message arrives while the older page is loading.
    const loading = useChatStore.getState().loadOlderMessages(CONVERSATION);
    const live = serverMessage({ senderId: PEER, text: 'live' });
    serverMessages.push(live);
    liveStream().handlers['message.created']!({ message: live });
    await loading;

    expect(list()).toHaveLength(total + 1);
    expect(texts()[0]).toBe('m0');
    expect(texts()[texts().length - 1]).toBe('live');
    expect(new Set(list().map((message) => message.id)).size).toBe(total + 1);
    expect(useChatStore.getState().hasMore[CONVERSATION]).toBe(false);
  });

  it('shows a message sent from another tab exactly once', async () => {
    await open();
    // No placeholder in this tab; the other tab's message arrives via stream,
    // then again via a reconnect catch-up.
    const other = serverMessage({ senderId: ME, text: 'from other tab', clientMessageId: 'cmsg_other' });
    serverMessages.push(other);
    liveStream().handlers['message.created']!({ message: other });
    liveStream().onError?.();
    liveStream().onReady?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(['from other tab']);
    // Own messages are never acknowledged as delivered by the sender's tabs.
    await vi.advanceTimersByTimeAsync(500);
    expect(deliveredCalls).toEqual([]);
  });

  it('uses exactly one stream per conversation and closes it on leave', async () => {
    await open();
    await open(); // re-open (e.g. media.viewed refresh or effect re-run)
    expect(streams.filter((stream) => !stream.closed)).toHaveLength(1);
    useChatStore.getState().leaveConversation(CONVERSATION);
    expect(streams.filter((stream) => !stream.closed)).toHaveLength(0);
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });
});

describe('typing indicator', () => {
  it('throttles outgoing indicators and stops on send', async () => {
    await open();
    for (let index = 0; index < 10; index += 1) {
      useChatStore.getState().noteComposerActivity(CONVERSATION, true);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(typingCalls).toEqual([true]);
    const sending = useChatStore.getState().sendText(CONVERSATION, 'done');
    expect(typingCalls).toEqual([true, false]);
    const stored = serverAccepts(sendCalls[0]!);
    sendCalls[0]!.done.resolve({ message: stored, conversation: conversationView });
    await sending;
    await vi.advanceTimersByTimeAsync(5000);
    expect(typingCalls).toEqual([true, false]);
  });

  it('shows the peer indicator, clears it when their message arrives, and expires it on its own', async () => {
    await open();
    const handlers = liveStream().handlers;
    handlers.typing!({ userId: PEER, isTyping: true });
    expect(useChatStore.getState().typingPeer[CONVERSATION]).toBe(true);
    // My own indicator echoed back is ignored.
    handlers.typing!({ userId: ME, isTyping: false });
    expect(useChatStore.getState().typingPeer[CONVERSATION]).toBe(true);

    const message = serverMessage({ senderId: PEER, text: 'sent it' });
    handlers['message.created']!({ message });
    expect(useChatStore.getState().typingPeer[CONVERSATION]).toBe(false);

    handlers.typing!({ userId: PEER, isTyping: true });
    await vi.advanceTimersByTimeAsync(8000);
    expect(useChatStore.getState().typingPeer[CONVERSATION]).toBe(false);
  });

  it('stops everything on reset (privacy lock)', async () => {
    await open();
    useChatStore.getState().noteComposerActivity(CONVERSATION, true);
    useChatStore.getState().reset();
    expect(typingCalls).toEqual([true, false]);
    expect(streams.filter((stream) => !stream.closed)).toHaveLength(0);
    expect(useChatStore.getState().messages).toEqual({});
  });
});

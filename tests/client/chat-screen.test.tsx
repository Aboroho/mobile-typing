/**
 * @vitest-environment jsdom
 *
 * Rendering-level checks for the chat screen: stable bubble identity across
 * the optimistic → canonical transition, visible status labels, the hide
 * button and the read-receipt reporting of rendered peer messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { MessageForUser } from '@mt/types';

const ME = 'u_me';
const PEER = 'u_peer';
const CONVERSATION = 'c_1';

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

let sendCalls: Array<{ input: { clientMessageId: string; text?: string }; done: Deferred<unknown> }> = [];
let readCalls: Array<{ lastReadMessageAt: string }> = [];
let initialMessages: MessageForUser[] = [];

const conversationView = {
  conversation: { id: CONVERSATION, participantIds: [ME, PEER], participants: {} },
  otherUser: { id: PEER, name: 'Peer Person', photoUrl: null, presence: 'online' },
  unreadCount: 0,
  hidden: false,
  isTyping: false,
};

vi.mock('@/lib/client/api', () => ({
  api: {
    access: { lock: vi.fn(async () => ({ ok: true })) },
    conversations: {
      get: vi.fn(async () => ({ conversation: conversationView, iceServers: [] })),
      list: vi.fn(async () => ({ items: [], hasMore: false })),
      typing: vi.fn(async () => ({ ok: true })),
      markRead: vi.fn(async (_id: string, input: { lastReadMessageAt: string }) => {
        readCalls.push(input);
        return { ok: true, updated: 1, messageIds: [] };
      }),
    },
    messages: {
      list: vi.fn(async () => ({ items: initialMessages, hasMore: false, nextCursor: null })),
      send: vi.fn((input: { clientMessageId: string; text?: string }) => {
        const done = deferred<unknown>();
        sendCalls.push({ input, done });
        return done.promise;
      }),
      markDelivered: vi.fn(async (_id: string, input: { messageIds: string[] }) => ({ updated: 0, messageIds: input.messageIds })),
      edit: vi.fn(),
      remove: vi.fn(),
    },
    media: { send: vi.fn() },
    users: { search: vi.fn(async () => ({ items: [] })) },
    calls: { end: vi.fn(async () => ({ ok: true })) },
  },
}));

type Handlers = Record<string, (payload: unknown) => void>;
let handlers: Handlers = {};
vi.mock('@/lib/browser/sse-client', () => ({
  connectEventStream: vi.fn((options: { events: Handlers; onReady?: () => void }) => {
    handlers = options.events;
    options.onReady?.();
    return () => undefined;
  }),
}));

import { ChatScreen } from '@/components/messages/chat-screen';
import { useAuthStore } from '@/stores/auth-store';
import { useAccessStore } from '@/stores/access-store';
import { useChatStore, __resetChatRuntimeForTests } from '@/stores/chat-store';

function message(overrides: Partial<MessageForUser> & { id: string; senderId: string; text: string }): MessageForUser {
  const at = overrides.createdAt ?? '2026-01-01T10:00:00.000Z';
  return {
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
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const flushAsync = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  sendCalls = [];
  readCalls = [];
  initialMessages = [];
  handlers = {};
  __resetChatRuntimeForTests();
  useChatStore.getState().reset();
  useAuthStore.setState({ user: { id: ME, name: 'Me' } as never });
  useAccessStore.setState({ unlocked: true, boundUserId: ME });
});

afterEach(() => {
  cleanup();
  __resetChatRuntimeForTests();
});

describe('ChatScreen', () => {
  it('keeps the same bubble element when the placeholder becomes the server message', async () => {
    render(createElement(ChatScreen, { conversationId: CONVERSATION, onBack: () => undefined }));
    await flushAsync();

    await act(async () => {
      void useChatStore.getState().sendText(CONVERSATION, 'stable');
    });
    const before = screen.getByText('stable').closest('[data-message-key]') as HTMLElement;
    expect(before).not.toBeNull();
    expect(screen.getByLabelText('Sending')).toBeTruthy();

    const clientMessageId = sendCalls[0]!.input.clientMessageId;
    const stored = message({ id: 'm_1', senderId: ME, text: 'stable', clientMessageId, createdAt: '2026-01-01T10:00:01.000Z' });
    act(() => {
      handlers['message.created']!({ message: stored });
    });
    await act(async () => {
      sendCalls[0]!.done.resolve({ message: stored, conversation: conversationView });
    });

    const after = screen.getByText('stable').closest('[data-message-key]') as HTMLElement;
    expect(after).toBe(before); // same DOM node: no unmount/remount
    expect(screen.getAllByText('stable')).toHaveLength(1);
    expect(screen.getByLabelText('Sent')).toBeTruthy();
  });

  it('shows distinct labels for sent, delivered, seen and failed messages', async () => {
    initialMessages = [
      message({ id: 'm_1', senderId: ME, text: 'one', deliveryState: 'sent', createdAt: '2026-01-01T10:00:01.000Z' }),
      message({ id: 'm_2', senderId: ME, text: 'two', deliveryState: 'delivered', createdAt: '2026-01-01T10:00:02.000Z' }),
      message({ id: 'm_3', senderId: ME, text: 'three', deliveryState: 'read', createdAt: '2026-01-01T10:00:03.000Z' }),
    ];
    render(createElement(ChatScreen, { conversationId: CONVERSATION, onBack: () => undefined }));
    await flushAsync();

    expect(screen.getByLabelText('Sent')).toBeTruthy();
    expect(screen.getByLabelText('Delivered')).toBeTruthy();
    expect(screen.getByLabelText('Seen')).toBeTruthy();

    await act(async () => {
      void useChatStore.getState().sendText(CONVERSATION, 'nope');
    });
    await act(async () => {
      sendCalls[0]!.done.reject(new Error('offline'));
    });
    expect(screen.getByText('Not sent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]!.input.clientMessageId).toBe(sendCalls[0]!.input.clientMessageId);
    expect(screen.getAllByText('nope')).toHaveLength(1);
  });

  it('reports rendered peer messages as seen and never its own', async () => {
    initialMessages = [
      message({ id: 'm_1', senderId: PEER, text: 'peer says', createdAt: '2026-01-01T10:00:01.000Z' }),
      message({ id: 'm_2', senderId: ME, text: 'i say', createdAt: '2026-01-01T10:00:02.000Z' }),
    ];
    render(createElement(ChatScreen, { conversationId: CONVERSATION, onBack: () => undefined }));
    await flushAsync();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(readCalls).toEqual([{ lastReadMessageAt: '2026-01-01T10:00:01.000Z' }]);
  });

  it('hides the chat from the header button', async () => {
    render(createElement(ChatScreen, { conversationId: CONVERSATION, onBack: () => undefined }));
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: /hide chat/i }));
    expect(useAccessStore.getState().unlocked).toBe(false);
    expect(useChatStore.getState().messages).toEqual({});
    expect(document.documentElement.classList.contains('privacy-locked')).toBe(true);
  });

  it('shows the typing bubble only while the peer is typing', async () => {
    render(createElement(ChatScreen, { conversationId: CONVERSATION, onBack: () => undefined }));
    await flushAsync();
    expect(screen.queryByTestId('typing-bubble')).toBeNull();
    act(() => {
      handlers.typing!({ userId: PEER, isTyping: true });
    });
    expect(screen.getByTestId('typing-bubble')).toBeTruthy();
    expect(screen.getByText('typing…')).toBeTruthy();
    act(() => {
      handlers.typing!({ userId: PEER, isTyping: false });
    });
    expect(screen.queryByTestId('typing-bubble')).toBeNull();
  });
});

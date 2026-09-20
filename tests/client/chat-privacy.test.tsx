/**
 * @vitest-environment jsdom
 *
 * Privacy wiring on the chat screen: the header Hide button and the double tap
 * inside the message list both hide the chat, and the controls in and around
 * the message area do not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ConversationView, MessageForUser, Timestamp } from '@mt/types';
import { ChatScreen } from '@/components/messages/chat-screen';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCallStore } from '@/stores/call-store';

vi.mock('@/lib/browser/realtime-client', () => {
  const client = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: () => 'websocket' as const,
    getLastEventId: () => null,
    onStatus: () => () => undefined,
    sendTyping: vi.fn(),
    unsubscribeConversation: vi.fn(),
    subscribeConversation: () => () => undefined,
  };
  return { getRealtimeClient: () => client, createRealtimeClient: () => client, resetRealtimeClient: () => undefined };
});

const CID = 'conv_privacy';

function iso(offset = 0): Timestamp {
  return new Date(1_700_000_000_000 + offset).toISOString() as Timestamp;
}

function conversationView(): ConversationView {
  return {
    conversation: {
      id: CID,
      participantIds: ['u_me', 'u_peer'],
      lastMessage: null,
      lastMessageAt: null,
      lastActivityAt: iso(),
      createdAt: iso(),
    },
    otherUser: { id: 'u_peer', name: 'Peer', photoUrl: null, presence: 'online' },
    unreadCount: 0,
    hidden: false,
    blockedUserIds: [],
  } as unknown as ConversationView;
}

function message(overrides: Partial<MessageForUser> = {}): MessageForUser {
  return {
    id: 'm_1',
    conversationId: CID,
    senderId: 'u_peer',
    type: 'text',
    text: 'a message to double tap on',
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
    createdAt: iso(),
    updatedAt: iso(),
    ...overrides,
  } as MessageForUser;
}

class PointerEventPolyfill extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'touch';
  }
}

function doubleTap(element: Element) {
  for (let index = 0; index < 2; index += 1) {
    element.dispatchEvent(
      new PointerEventPolyfill('pointerdown', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 240,
        pointerType: 'touch',
        button: 0,
      }),
    );
  }
}

describe('chat screen privacy controls', () => {
  beforeEach(() => {
    if (typeof globalThis.PointerEvent === 'undefined') {
      (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
      (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    useAuthStore.setState({ user: { id: 'u_me' } as never, initializing: false, error: null, pending: false });
    useCallStore.setState({ call: null, incoming: null, state: 'idle' });
    useChatStore.setState({
      activeConversationId: CID,
      activeConversation: conversationView(),
      messages: { [CID]: [message()] },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes a hide button that hides the chat', () => {
    const onHide = vi.fn();
    render(<ChatScreen conversationId={CID} onBack={() => undefined} onHide={onHide} />);
    const button = screen.getByRole('button', { name: /hide chat/i });
    button.click();
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('hides the chat on a double tap inside the message list', () => {
    const onHide = vi.fn();
    render(<ChatScreen conversationId={CID} onBack={() => undefined} onHide={onHide} />);
    doubleTap(screen.getByText('a message to double tap on'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('does not hide the chat when a button inside the message list is double tapped', () => {
    const onHide = vi.fn();
    render(<ChatScreen conversationId={CID} onBack={() => undefined} onHide={onHide} />);
    doubleTap(screen.getByRole('button', { name: /load earlier messages/i }));
    expect(onHide).not.toHaveBeenCalled();
  });

  it('does not hide the chat when the header buttons are double tapped', () => {
    const onHide = vi.fn();
    render(<ChatScreen conversationId={CID} onBack={() => undefined} onHide={onHide} />);
    doubleTap(screen.getByRole('button', { name: /start audio call/i }));
    doubleTap(screen.getByRole('button', { name: /back to conversations/i }));
    expect(onHide).not.toHaveBeenCalled();
  });

  it('does not hide the chat when the composer textarea is double tapped', () => {
    const onHide = vi.fn();
    render(<ChatScreen conversationId={CID} onBack={() => undefined} onHide={onHide} />);
    doubleTap(screen.getByRole('textbox', { name: 'Message' }));
    expect(onHide).not.toHaveBeenCalled();
  });

  it('does not hide the chat on a single tap', () => {
    const onHide = vi.fn();
    render(<ChatScreen conversationId={CID} onBack={() => undefined} onHide={onHide} />);
    screen.getByText('a message to double tap on').dispatchEvent(
      new PointerEventPolyfill('pointerdown', { bubbles: true, clientX: 120, clientY: 240, pointerType: 'touch' }),
    );
    expect(onHide).not.toHaveBeenCalled();
  });
});

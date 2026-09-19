import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetStore } from '@/lib/data/memory';
import type { MessageForUser } from '@mt/types';
import { subscribe, topics, type RealtimeEvent } from '@/lib/realtime/bus';
import { POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { POST as sendMessageRoute } from '@/app/api/v1/messages/route';
import { GET as getMessageRoute } from '@/app/api/v1/messages/[messageId]/route';
import { GET as listMessagesRoute } from '@/app/api/v1/conversations/[conversationId]/messages/route';
import { POST as deliveryRoute } from '@/app/api/v1/conversations/[conversationId]/messages/delivery/route';
import { POST as readRoute } from '@/app/api/v1/conversations/[conversationId]/read/route';
import { POST as typingRoute } from '@/app/api/v1/conversations/[conversationId]/typing/route';
import { GET as listConversationsRoute } from '@/app/api/v1/conversations/route';
import { call, jsonRequest, queryRequest, registerUser, type TestUser } from '../helpers/api';

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let conversationId: string;
const unsubscribes: Array<() => void> = [];

async function createConversation(actor: TestUser, participantId: string): Promise<string> {
  const result = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId }, actor.jar),
  );
  return result.body.data!.conversation.conversation.id;
}

async function send(actor: TestUser, text: string): Promise<MessageForUser> {
  const result = await call<{ message: MessageForUser }>(
    sendMessageRoute,
    jsonRequest(
      'POST',
      '/api/v1/messages',
      { conversationId, type: 'text', text, clientMessageId: `cm-${Math.random().toString(36).slice(2)}` },
      actor.jar,
    ),
  );
  if (result.status !== 201) throw new Error(`send failed: ${result.status}`);
  return result.body.data!.message;
}

async function stateOf(messageId: string, viewer: TestUser): Promise<string | undefined> {
  const current = await call<{ message: MessageForUser }>(
    getMessageRoute,
    queryRequest('GET', `/api/v1/messages/${messageId}`, undefined, viewer.jar),
    { messageId },
  );
  return current.body.data?.message.deliveryState;
}

function collect(topic: string): RealtimeEvent[] {
  const events: RealtimeEvent[] = [];
  unsubscribes.push(subscribe(topic, (event) => events.push(event)));
  return events;
}

function markRead(actor: TestUser, lastReadMessageAt: string) {
  return call<{ ok: true; updated: number; messageIds: string[] }>(
    readRoute,
    jsonRequest('POST', `/api/v1/conversations/${conversationId}/read`, { lastReadMessageAt }, actor.jar),
    { conversationId },
  );
}

function markDelivered(actor: TestUser, messageIds: string[], state: 'delivered' | 'read') {
  return call<{ updated: number; messageIds: string[] }>(
    deliveryRoute,
    jsonRequest('POST', `/api/v1/conversations/${conversationId}/messages/delivery`, { messageIds, state }, actor.jar),
    { conversationId },
  );
}

beforeEach(async () => {
  resetStore();
  alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
  bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
  carol = await registerUser({ name: 'Carol', email: 'carol@example.com' });
  conversationId = await createConversation(alice, bob.id);
});

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
});

describe('delivery receipts', () => {
  it('batches several ids into one write and one event listing only what changed', async () => {
    const first = await send(alice, 'one');
    const second = await send(alice, 'two');
    const events = collect(topics.messages(conversationId));

    const receipt = await markDelivered(bob, [first.id, second.id, second.id, 'm_does_not_exist'], 'delivered');
    expect(receipt.status).toBe(200);
    expect(receipt.body.data).toEqual({ updated: 2, messageIds: expect.arrayContaining([first.id, second.id]) });

    const delivery = events.filter((event) => event.type === 'message.delivery');
    expect(delivery).toHaveLength(1);
    expect(delivery[0]!.payload).toMatchObject({
      state: 'delivered',
      userId: bob.id,
      // Addressed to the author only; the stream filter uses this field.
      otherUserId: alice.id,
    });
    expect((delivery[0]!.payload as { messageIds: string[] }).messageIds.sort()).toEqual([first.id, second.id].sort());
    expect(await stateOf(first.id, alice)).toBe('delivered');
  });

  it('is a silent no-op when repeated — no write, no event', async () => {
    const message = await send(alice, 'again');
    await markDelivered(bob, [message.id], 'delivered');
    const events = collect(topics.messages(conversationId));

    const repeat = await markDelivered(bob, [message.id], 'delivered');
    expect(repeat.body.data).toEqual({ updated: 0, messageIds: [] });
    expect(events.filter((event) => event.type === 'message.delivery')).toHaveLength(0);
  });

  it('cannot be sent by a non-participant', async () => {
    const message = await send(alice, 'private');
    const denied = await markDelivered(carol, [message.id], 'delivered');
    expect(denied.status).toBe(404);
    expect(await stateOf(message.id, alice)).toBe('sent');
  });

  it('ignores ids that belong to another conversation', async () => {
    const other = await createConversation(alice, carol.id);
    const foreign = await call<{ message: MessageForUser }>(
      sendMessageRoute,
      jsonRequest(
        'POST',
        '/api/v1/messages',
        { conversationId: other, type: 'text', text: 'elsewhere', clientMessageId: 'cm-foreign' },
        alice.jar,
      ),
    );
    const receipt = await markDelivered(bob, [foreign.body.data!.message.id], 'delivered');
    expect(receipt.body.data).toEqual({ updated: 0, messageIds: [] });
  });
});

describe('read watermark', () => {
  it('marks the peer messages at or before the watermark as read and leaves newer ones alone', async () => {
    const first = await send(alice, 'first');
    const second = await send(alice, 'second');
    const mine = await send(bob, 'from bob');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await send(alice, 'later');
    const events = collect(topics.messages(conversationId));
    const conversationEvents = collect(topics.conversation(conversationId));

    const receipt = await markRead(bob, second.createdAt);
    expect(receipt.status).toBe(200);
    expect(receipt.body.data?.updated).toBe(2);
    expect(receipt.body.data?.messageIds.sort()).toEqual([first.id, second.id].sort());

    expect(await stateOf(first.id, alice)).toBe('read');
    expect(await stateOf(second.id, alice)).toBe('read');
    expect(await stateOf(later.id, alice)).toBe('sent');
    // The reader's own message is never touched by their own watermark.
    expect(await stateOf(mine.id, bob)).toBe('sent');

    const delivery = events.filter((event) => event.type === 'message.delivery');
    expect(delivery).toHaveLength(1);
    expect(delivery[0]!.payload).toMatchObject({ state: 'read', userId: bob.id, otherUserId: alice.id });
    const read = conversationEvents.filter((event) => event.type === 'conversation.read');
    expect(read).toHaveLength(1);
    expect(read[0]!.payload).toMatchObject({ userId: bob.id, lastReadMessageAt: second.createdAt, otherUserId: alice.id });
  });

  it('does not re-emit receipts for messages that are already read', async () => {
    const message = await send(alice, 'once');
    await markRead(bob, message.createdAt);
    const events = collect(topics.messages(conversationId));

    const repeat = await markRead(bob, message.createdAt);
    expect(repeat.body.data?.updated).toBe(0);
    expect(events.filter((event) => event.type === 'message.delivery')).toHaveLength(0);
  });

  it('never moves the reader bookkeeping backwards', async () => {
    const first = await send(alice, 'a');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await send(alice, 'b');
    await markRead(bob, second.createdAt);
    // A stale request from another tab reports an older watermark.
    await markRead(bob, first.createdAt);

    const list = await call<{
      items: Array<{
        conversation: { id: string; participants: Record<string, { lastReadMessageAt: string | null }> };
        unreadCount: number;
      }>;
    }>(listConversationsRoute, queryRequest('GET', '/api/v1/conversations', { limit: 10 }, bob.jar));
    const view = list.body.data!.items.find((item) => item.conversation.id === conversationId)!;
    expect(view.unreadCount).toBe(0);
    expect(view.conversation.participants[bob.id]?.lastReadMessageAt).toBe(second.createdAt);
  });

  it('is refused for a non-participant', async () => {
    const message = await send(alice, 'nope');
    const denied = await markRead(carol, message.createdAt);
    expect(denied.status).toBe(404);
    expect(await stateOf(message.id, alice)).toBe('sent');
  });

  it('gives the recipient the read state through the message list', async () => {
    const message = await send(alice, 'listed');
    await markRead(bob, message.createdAt);
    const forAlice = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, { limit: 10 }, alice.jar),
      { conversationId },
    );
    expect(forAlice.body.data?.items.find((item) => item.id === message.id)?.deliveryState).toBe('read');
  });
});

describe('typing indicator', () => {
  it('is relayed to the other participant only and never stored', async () => {
    const events = collect(topics.typing(conversationId));
    const response = await call(
      typingRoute,
      jsonRequest('POST', `/api/v1/conversations/${conversationId}/typing`, { isTyping: true }, alice.jar),
      { conversationId },
    );
    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ userId: alice.id, isTyping: true, otherUserId: bob.id });
    expect(typeof (events[0]!.payload as { at: string }).at).toBe('string');

    // Nothing about typing appears in the message history.
    const forBob = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, { limit: 10 }, bob.jar),
      { conversationId },
    );
    expect(forBob.body.data?.items).toEqual([]);
  });

  it('cannot be sent by a non-participant', async () => {
    const events = collect(topics.typing(conversationId));
    const denied = await call(
      typingRoute,
      jsonRequest('POST', `/api/v1/conversations/${conversationId}/typing`, { isTyping: true }, carol.jar),
      { conversationId },
    );
    expect(denied.status).toBe(404);
    expect(events).toHaveLength(0);
  });
});

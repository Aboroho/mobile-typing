/**
 * Message idempotency, delivery/read receipts and outbox durability, against
 * the real API routes and the durable outbox.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageForUser } from '@mt/types';
import { POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { POST as sendMessageRoute } from '@/app/api/v1/messages/route';
import { GET as listMessagesRoute } from '@/app/api/v1/conversations/[conversationId]/messages/route';
import { POST as deliveryRoute } from '@/app/api/v1/conversations/[conversationId]/messages/delivery/route';
import { getData } from '@/lib/data';
import { publishEvent, runOutboxWorker } from '@/lib/realtime/outbox';
import { subscribe, topics } from '@/lib/realtime/bus';
import { call, jsonRequest, queryRequest, registerUser, resetState, type TestUser } from '../helpers/api';

beforeEach(() => resetState());

async function conversation(alice: TestUser, bob: TestUser): Promise<string> {
  const created = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId: bob.id }, alice.jar),
  );
  if (!created.body.data) throw new Error('conversation failed');
  return created.body.data.conversation.conversation.id;
}

async function send(
  from: TestUser,
  conversationId: string,
  text: string,
  clientMessageId: string,
): Promise<{ status: number; message?: MessageForUser }> {
  const result = await call<{ message: MessageForUser }>(
    sendMessageRoute,
    jsonRequest('POST', '/api/v1/messages', { conversationId, type: 'text', text, clientMessageId }, from.jar),
  );
  return { status: result.status, message: result.body.data?.message };
}

describe('idempotent message creation', () => {
  it('returns the same row when the same clientMessageId is submitted twice', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await conversation(alice, bob);

    const first = await send(alice, cid, 'hello', 'cmsg_dup');
    const second = await send(alice, cid, 'hello', 'cmsg_dup');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.message?.id).toBe(first.message?.id);

    const inbox = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${cid}/messages`, undefined, bob.jar),
      { conversationId: cid },
    );
    expect(inbox.body.data?.items).toHaveLength(1);
  });

  it('does not create a duplicate when three retries race', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await conversation(alice, bob);

    const results = await Promise.all([
      send(alice, cid, 'racing', 'cmsg_race'),
      send(alice, cid, 'racing', 'cmsg_race'),
      send(alice, cid, 'racing', 'cmsg_race'),
    ]);
    const ids = new Set(results.map((r) => r.message?.id).filter(Boolean));
    expect(ids.size).toBe(1);

    const inbox = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${cid}/messages`, undefined, alice.jar),
      { conversationId: cid },
    );
    expect(inbox.body.data?.items).toHaveLength(1);
  });

  it('a different clientMessageId is a different message', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await conversation(alice, bob);
    const a = await send(alice, cid, 'one', 'cmsg_alpha_001');
    const b = await send(alice, cid, 'two', 'cmsg_bravo_002');
    expect(a.message?.id).not.toBe(b.message?.id);
  });
});

describe('delivery and read receipts', () => {
  it('only the recipient can advance a receipt', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await conversation(alice, bob);
    const sent = await send(alice, cid, 'hello', 'cmsg_receipt');
    const messageId = sent.message!.id;

    // The author trying to mark their own message read must change nothing.
    const byAuthor = await call<{ updated: number }>(
      deliveryRoute,
      jsonRequest('POST', `/api/v1/conversations/${cid}/messages/delivery`, { messageIds: [messageId], state: 'read' }, alice.jar),
      { conversationId: cid },
    );
    expect(byAuthor.body.data?.updated).toBe(0);

    const byRecipient = await call<{ updated: number }>(
      deliveryRoute,
      jsonRequest('POST', `/api/v1/conversations/${cid}/messages/delivery`, { messageIds: [messageId], state: 'read' }, bob.jar),
      { conversationId: cid },
    );
    expect(byRecipient.body.data?.updated).toBe(1);

    // Repeating the same receipt is a no-op, not a second write.
    const repeat = await call<{ updated: number }>(
      deliveryRoute,
      jsonRequest('POST', `/api/v1/conversations/${cid}/messages/delivery`, { messageIds: [messageId], state: 'read' }, bob.jar),
      { conversationId: cid },
    );
    expect(repeat.body.data?.updated).toBe(0);
  });

  it('a non-participant cannot touch receipts', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const carol = await registerUser({ name: 'Carol', email: 'carol@example.com' });
    const cid = await conversation(alice, bob);
    const sent = await send(alice, cid, 'hello', 'cmsg_outsider');

    const denied = await call(
      deliveryRoute,
      jsonRequest(
        'POST',
        `/api/v1/conversations/${cid}/messages/delivery`,
        { messageIds: [sent.message!.id], state: 'read' },
        carol.jar,
      ),
      { conversationId: cid },
    );
    expect(denied.status).toBe(404);
  });

  it('publishes a durable event addressed to the sender when a receipt lands', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await conversation(alice, bob);
    const sent = await send(alice, cid, 'hello', 'cmsg_event');

    const seen: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = subscribe(topics.messages(cid), (event) => seen.push({ type: event.type, payload: event.payload }));

    await call(
      deliveryRoute,
      jsonRequest(
        'POST',
        `/api/v1/conversations/${cid}/messages/delivery`,
        { messageIds: [sent.message!.id], state: 'delivered' },
        bob.jar,
      ),
      { conversationId: cid },
    );
    unsubscribe();

    const delivered = seen.find((event) => event.type === 'message.delivered');
    expect(delivered).toBeTruthy();
    expect((delivered!.payload as { otherUserId: string }).otherUserId).toBe(alice.id);
  });
});

describe('durable outbox', () => {
  it('writes one row per recipient and survives a republish by the worker', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const data = await getData();

    await publishEvent({
      topic: topics.messages('c_outbox'),
      type: 'message.created',
      recipients: [
        { userId: alice.id, payload: { conversationId: 'c_outbox', forUserId: alice.id } },
        { userId: bob.id, payload: { conversationId: 'c_outbox', forUserId: bob.id } },
      ],
    });

    expect((await data.outbox.listForUser(alice.id, null, 10))).toHaveLength(1);
    expect((await data.outbox.listForUser(bob.id, null, 10))).toHaveLength(1);

    // Already published in-process, so the worker must not publish it again.
    const republished: string[] = [];
    const unsubscribe = subscribe(topics.messages('c_outbox'), (event) => republished.push(event.type));
    const worker = runOutboxWorker({ pollMs: 10, graceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.stop();
    unsubscribe();
    expect(republished).toHaveLength(0);
  });

  it('recovers an event that was written but never published', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const data = await getData();
    // Simulates a crash between the transaction commit and the publish: the row
    // exists, `deliveredAt` is still null.
    await data.outbox.enqueue({
      id: 'evt_000000000_0000_recover',
      userId: alice.id,
      topic: topics.messages('c_recover'),
      type: 'message.created',
      payload: { conversationId: 'c_recover', forUserId: alice.id },
      createdAt: new Date(Date.now() - 10_000),
    });

    const received: string[] = [];
    const unsubscribe = subscribe(topics.messages('c_recover'), (event) => received.push(event.type));
    const worker = runOutboxWorker({ pollMs: 10, graceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.stop();
    unsubscribe();

    expect(received).toEqual(['message.created']);
    // Marked, so the next tick does not replay it a second time.
    expect((await data.outbox.claimPending(10))).toHaveLength(0);
  });

  it('replays events after a cursor, in creation order', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const data = await getData();
    for (let index = 0; index < 3; index += 1) {
      await publishEvent({
        topic: topics.messages('c_cursor'),
        type: 'message.created',
        recipients: [{ userId: alice.id, payload: { conversationId: 'c_cursor', index } }],
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const all = await data.outbox.listForUser(alice.id, null, 10);
    expect(all).toHaveLength(3);
    const afterFirst = await data.outbox.listForUser(alice.id, all[0]!.id, 10);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst.map((event) => (event.payload as { index: number }).index)).toEqual([1, 2]);
  });

  it('prunes rows past the retention cutoff', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const data = await getData();
    await data.outbox.enqueue({
      id: 'evt_old',
      userId: alice.id,
      topic: 't',
      type: 'message.created',
      payload: {},
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const pruned = await data.outbox.pruneOlderThan(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    expect(pruned).toBe(1);
    expect(await data.outbox.listForUser(alice.id, null, 10)).toHaveLength(0);
  });
});

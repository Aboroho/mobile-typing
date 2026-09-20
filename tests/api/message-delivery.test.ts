/**
 * Delivery semantics: notify first, persist second.
 *
 * The socket notification must never wait for the database: the message is
 * published to the live transport before (and independently of) the insert,
 * and an insert that fails retracts the already-delivered message instead of
 * leaving a bubble with no storage behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore } from '@/lib/data/memory';
import { getData } from '@/lib/data';
import type { Message } from '@mt/types';
import type { RealtimeEvent } from '@/lib/realtime/bus';
import { subscribe, topics } from '@/lib/realtime/bus';
import { waitForPendingMessageWrites } from '@/lib/services/message-service';
import { POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { POST as sendMessageRoute } from '@/app/api/v1/messages/route';
import { GET as listMessagesRoute } from '@/app/api/v1/conversations/[conversationId]/messages/route';
import { call, jsonRequest, queryRequest, registerUser, type TestUser } from '../helpers/api';

let alice: TestUser;
let bob: TestUser;
let conversationId: string;
let unsubscribes: Array<() => void> = [];

beforeEach(async () => {
  resetStore();
  alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
  bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
  const result = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId: bob.id }, alice.jar),
  );
  if (result.status !== 201 || !result.body.data) throw new Error('conversation create failed');
  conversationId = result.body.data.conversation.conversation.id;
  unsubscribes = [];
});

afterEach(async () => {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  vi.restoreAllMocks();
  await waitForPendingMessageWrites();
});

function watchMessages(): RealtimeEvent[] {
  const events: RealtimeEvent[] = [];
  unsubscribes.push(subscribe(topics.messages(conversationId), (event) => events.push(event)));
  return events;
}

function send(text: string, clientMessageId: string, actor: TestUser = alice) {
  return call<{ message: { id: string; text: string | null } }>(
    sendMessageRoute,
    jsonRequest(
      'POST',
      '/api/v1/messages',
      { conversationId, type: 'text', text, clientMessageId },
      actor.jar,
    ),
  );
}

describe('notify-first delivery', () => {
  it('publishes message.created before the database insert finishes', async () => {
    const data = await getData();
    const events = watchMessages();

    // Gate the insert: it cannot complete until we say so.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCreate = data.messages.create.bind(data.messages);
    const create = vi
      .spyOn(data.messages, 'create')
      .mockImplementation(async (message: Message) => {
        await gate;
        return originalCreate(message);
      });

    const pending = send('instant', 'cm-instant');

    // Delivery does not wait for the blocked insert.
    await vi.waitFor(() => expect(events.some((e) => e.type === 'message.created')).toBe(true));
    expect(create).toHaveBeenCalledTimes(1);

    release();
    const sent = await pending;
    expect(sent.status).toBe(201);
    await waitForPendingMessageWrites();

    // And the database caught up afterwards.
    const list = await call<{ items: Array<{ text: string | null }> }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, { limit: 10 }, bob.jar),
      { conversationId },
    );
    expect(list.body.data?.items.map((item) => item.text)).toContain('instant');
  });

  it('delivers to both participants with per-viewer payloads', async () => {
    const events = watchMessages();
    const sent = await send('hi bob', 'cm-both-1');
    expect(sent.status).toBe(201);

    const created = events.filter((event) => event.type === 'message.created');
    expect(created).toHaveLength(2);
    const addressedTo = created.map((event) => (event.payload as { forUserId: string }).forUserId).sort();
    expect(addressedTo).toEqual([alice.id, bob.id].sort());
  });

  it('retracts the delivered message when the insert fails', async () => {
    const data = await getData();
    const events = watchMessages();
    vi.spyOn(data.messages, 'create').mockRejectedValueOnce(new Error('disk on fire'));

    // The REST response still succeeds — delivery already happened and storage
    // catching up is not the sender's problem to observe.
    const sent = await send('ephemeral', 'cm-retract');
    expect(sent.status).toBe(201);
    await waitForPendingMessageWrites();

    const types = events.map((event) => event.type);
    expect(types).toContain('message.created');
    expect(types).toContain('message.retracted');
    const retracted = events.find((event) => event.type === 'message.retracted');
    expect((retracted?.payload as { clientMessageId: string }).clientMessageId).toBe('cm-retract');

    // Nothing visible survives for either participant.
    const list = await call<{ items: Array<{ text: string | null }> }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, { limit: 10 }, bob.jar),
      { conversationId },
    );
    expect(list.body.data?.items.map((item) => item.text)).not.toContain('ephemeral');
  });

  it('lets a retry deliver again after a failed insert', async () => {
    const data = await getData();
    const events = watchMessages();
    vi.spyOn(data.messages, 'create').mockRejectedValueOnce(new Error('brief outage'));

    await send('retry me', 'cm-retry');
    await waitForPendingMessageWrites();
    expect(events.some((event) => event.type === 'message.retracted')).toBe(true);

    // The idempotency entry was dropped by the retraction, so the retry is a
    // fresh send instead of a no-op duplicate.
    const retried = await send('retry me', 'cm-retry');
    expect(retried.status).toBe(201);
    await waitForPendingMessageWrites();

    const list = await call<{ items: Array<{ text: string | null }> }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, { limit: 10 }, bob.jar),
      { conversationId },
    );
    expect(list.body.data?.items.filter((item) => item.text === 'retry me')).toHaveLength(1);
  });

  it('delivers exactly once when a retry races the original send', async () => {
    const data = await getData();
    const events = watchMessages();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCreate = data.messages.create.bind(data.messages);
    vi.spyOn(data.messages, 'create').mockImplementation(async (message: Message) => {
      await gate;
      return originalCreate(message);
    });

    // Both requests go out at once — straight at the handler, without the
    // test-helper flush, which would serialise them.
    const request = () =>
      sendMessageRoute(
        jsonRequest(
          'POST',
          '/api/v1/messages',
          { conversationId, type: 'text', text: 'racing', clientMessageId: 'cm-race-01' },
          alice.jar,
        ),
      );
    const [responseA, responseB] = await Promise.all([request(), request()]);
    const a = (await responseA.json()) as { data?: { message: { id: string } } };
    const b = (await responseB.json()) as { data?: { message: { id: string } } };
    release();
    await waitForPendingMessageWrites();

    // Both requests answer with the same message id…
    expect(responseA.status).toBe(201);
    expect(responseB.status).toBe(201);
    expect(a.data?.message.id).toBe(b.data?.message.id);
    // …and the live transport saw exactly one logical delivery (one payload
    // per participant, all carrying the same message).
    const delivered = events.filter((event) => event.type === 'message.created');
    const deliveredIds = new Set(
      delivered.map((event) => (event.payload as { message: { id: string } }).message.id),
    );
    expect(deliveredIds.size).toBe(1);
    expect(delivered.length).toBeLessThanOrEqual(2);

    const list = await call<{ items: Array<{ text: string | null }> }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, { limit: 10 }, bob.jar),
      { conversationId },
    );
    expect(list.body.data?.items.filter((item) => item.text === 'racing')).toHaveLength(1);
  });
});

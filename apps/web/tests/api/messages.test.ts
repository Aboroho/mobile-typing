import { beforeEach, describe, expect, it } from 'vitest';
import { resetStore } from '@/lib/data/memory';
import { MESSAGE_EDIT_WINDOW_MS, type MessageForUser } from '@mt/types';
import { POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { POST as sendMessageRoute } from '@/app/api/v1/messages/route';
import { GET as getMessageRoute, PATCH as editMessageRoute, DELETE as deleteMessageRoute } from '@/app/api/v1/messages/[messageId]/route';
import { GET as listMessagesRoute } from '@/app/api/v1/conversations/[conversationId]/messages/route';
import { POST as deliveryRoute } from '@/app/api/v1/conversations/[conversationId]/messages/delivery/route';
import { call, jsonRequest, queryRequest, registerUser, type TestUser } from '../helpers/api';

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let conversationId: string;

async function createConversation(actor: TestUser, participantId: string): Promise<string> {
  const result = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId }, actor.jar),
  );
  if (result.status !== 201 || !result.body.data) {
    throw new Error(`create conversation failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body.data.conversation.conversation.id;
}

async function send(actor: TestUser, text: string, clientMessageId = `cm-${Math.random().toString(36).slice(2)}`) {
  return call<{ message: MessageForUser }>(
    sendMessageRoute,
    jsonRequest(
      'POST',
      '/api/v1/messages',
      { conversationId, type: 'text', text, clientMessageId },
      actor.jar,
    ),
  );
}

beforeEach(async () => {
  resetStore();
  alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
  bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
  carol = await registerUser({ name: 'Carol', email: 'carol@example.com' });
  conversationId = await createConversation(alice, bob.id);
});

describe('conversations', () => {
  it('are strictly 1:1 and idempotent for the same pair', async () => {
    const fromBob = await createConversation(bob, alice.id);
    expect(fromBob).toBe(conversationId);
  });

  it('give a non-participant no access at all', async () => {
    // A stranger gets 404 rather than 403 so the existence of a conversation is
    // not revealed to someone who guesses an id.
    const denied = await call(listMessagesRoute, queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, undefined, carol.jar), { conversationId });
    expect(denied.status).toBe(404);
    const sendDenied = await call(
      sendMessageRoute,
      jsonRequest('POST', '/api/v1/messages', { conversationId, type: 'text', text: 'hi', clientMessageId: 'cm-carol-1' }, carol.jar),
    );
    expect(sendDenied.status).toBe(404);
  });
});

describe('sending messages', () => {
  it('stores the message and shows it to both participants', async () => {
    const sent = await send(alice, 'hello bob');
    expect(sent.status).toBe(201);
    expect(sent.body.data?.message.text).toBe('hello bob');

    const forBob = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, { limit: 10 }, bob.jar),
      { conversationId },
    );
    expect(forBob.body.data?.items.map((item) => item.text)).toContain('hello bob');
  });

  it('is idempotent for a retried clientMessageId', async () => {
    const first = await send(alice, 'retry me', 'cm-fixed-id-1');
    const second = await send(alice, 'retry me', 'cm-fixed-id-1');
    expect(first.body.data?.message.id).toBe(second.body.data?.message.id);
  });

  it('rejects an over-long message before storing it', async () => {
    const tooLong = await send(alice, 'x'.repeat(4001));
    expect(tooLong.status).toBe(422);
  });

  it('strips control characters and trims whitespace', async () => {
    const sent = await send(alice, '  hi\u0000there  ');
    expect(sent.body.data?.message.text).toBe('hithere');
  });
});

describe('delivery and read receipts', () => {
  it('advances sent → delivered → read and never backwards', async () => {
    const sent = await send(alice, 'ping');
    const messageId = sent.body.data!.message.id;

    const delivered = await call(
      deliveryRoute,
      jsonRequest('POST', `/api/v1/conversations/${conversationId}/messages/delivery`, { messageIds: [messageId], state: 'delivered' }, bob.jar),
      { conversationId },
    );
    expect(delivered.status).toBe(200);

    const read = await call(
      deliveryRoute,
      jsonRequest('POST', `/api/v1/conversations/${conversationId}/messages/delivery`, { messageIds: [messageId], state: 'read' }, bob.jar),
      { conversationId },
    );
    expect(read.status).toBe(200);

    const downgraded = await call(
      deliveryRoute,
      jsonRequest('POST', `/api/v1/conversations/${conversationId}/messages/delivery`, { messageIds: [messageId], state: 'delivered' }, bob.jar),
      { conversationId },
    );
    expect(downgraded.status).toBe(200);
    const current = await call<{ message: MessageForUser }>(getMessageRoute, queryRequest('GET', `/api/v1/messages/${messageId}`, undefined, alice.jar), { messageId });
    expect(current.body.data?.message.deliveryState).toBe('read');
  });

  it('ignores a receipt from the author, who cannot mark their own message read', async () => {
    const sent = await send(alice, 'self read');
    const messageId = sent.body.data!.message.id;
    const ignored = await call(
      deliveryRoute,
      jsonRequest(
        'POST',
        `/api/v1/conversations/${conversationId}/messages/delivery`,
        { messageIds: [messageId], state: 'read' },
        alice.jar,
      ),
      { conversationId },
    );
    expect(ignored.status).toBe(200);
    const current = await call<{ message: MessageForUser }>(getMessageRoute, queryRequest('GET', `/api/v1/messages/${messageId}`, undefined, alice.jar), { messageId });
    expect(current.body.data?.message.deliveryState).toBe('sent');
  });
});

describe('editing', () => {
  it('lets the author edit inside the window and records the history', async () => {
    const sent = await send(alice, 'original');
    const messageId = sent.body.data!.message.id;
    const edited = await call<{ message: MessageForUser }>(
      editMessageRoute,
      jsonRequest('PATCH', `/api/v1/messages/${messageId}`, { text: 'corrected' }, alice.jar),
      { messageId },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.data?.message.text).toBe('corrected');
    expect(edited.body.data?.message.edited).toBe(true);
    // The full history stays server side.
    expect('editHistory' in (edited.body.data?.message as object)).toBe(false);
  });

  it('refuses an edit by the other participant', async () => {
    const sent = await send(alice, 'mine');
    const denied = await call(
      editMessageRoute,
      jsonRequest('PATCH', `/api/v1/messages/${sent.body.data!.message.id}`, { text: 'hacked' }, bob.jar),
      { messageId: sent.body.data!.message.id },
    );
    // 403: authorship is an authorisation failure, not a state problem.
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('FORBIDDEN');
  });

  it('refuses an edit after the two minute window', async () => {
    const sent = await send(alice, 'too late');
    const messageId = sent.body.data!.message.id;
    // Age the message past the server-side window.
    const { getData } = await import('@/lib/data');
    const data = await getData();
    await data.messages.update(messageId, {
      createdAt: new Date(Date.now() - MESSAGE_EDIT_WINDOW_MS - 1000).toISOString(),
    } as never);

    const late = await call(
      editMessageRoute,
      jsonRequest('PATCH', `/api/v1/messages/${messageId}`, { text: 'nope' }, alice.jar),
      { messageId },
    );
    expect(late.status).toBe(412);
    expect(late.body.error?.message).toMatch(/2 minutes/);
  });
});

describe('deletion', () => {
  it('soft deletes for everyone and hides the content', async () => {
    const sent = await send(alice, 'delete me');
    const messageId = sent.body.data!.message.id;
    const deleted = await call(
      deleteMessageRoute,
      jsonRequest('DELETE', `/api/v1/messages/${messageId}`, { scope: 'everyone', reason: 'typo' }, alice.jar),
      { messageId },
    );
    expect(deleted.status).toBe(200);

    const forBob = await call<{ message: MessageForUser }>(getMessageRoute, queryRequest('GET', `/api/v1/messages/${messageId}`, undefined, bob.jar), { messageId });
    expect(forBob.body.data?.message.deleted).toBe(true);
    expect(forBob.body.data?.message.text).toBeNull();
  });

  it('can be scoped to the sender only', async () => {
    const sent = await send(alice, 'only for me');
    const messageId = sent.body.data!.message.id;
    await call(
      deleteMessageRoute,
      jsonRequest('DELETE', `/api/v1/messages/${messageId}`, { scope: 'me' }, alice.jar),
      { messageId },
    );
    const forAlice = await call<{ message: MessageForUser }>(getMessageRoute, queryRequest('GET', `/api/v1/messages/${messageId}`, undefined, alice.jar), { messageId });
    const forBob = await call<{ message: MessageForUser }>(getMessageRoute, queryRequest('GET', `/api/v1/messages/${messageId}`, undefined, bob.jar), { messageId });
    expect(forAlice.body.data?.message.deleted).toBe(true);
    expect(forBob.body.data?.message.deleted).toBe(false);
    expect(forBob.body.data?.message.text).toBe('only for me');
  });

  it('keeps the original text for administrators', async () => {
    const sent = await send(alice, 'incriminating');
    const messageId = sent.body.data!.message.id;
    await call(deleteMessageRoute, jsonRequest('DELETE', `/api/v1/messages/${messageId}`, { scope: 'everyone' }, alice.jar), { messageId });

    const { getData } = await import('@/lib/data');
    const data = await getData();
    const stored = await data.messages.getById(messageId);
    expect(stored?.deleted).toBe(true);
    expect(stored?.metadata?.originalText).toBe('incriminating');
  });

  it('cannot be performed by a third party', async () => {
    const sent = await send(alice, 'not yours');
    const denied = await call(
      deleteMessageRoute,
      jsonRequest('DELETE', `/api/v1/messages/${sent.body.data!.message.id}`, { scope: 'everyone' }, carol.jar),
      { messageId: sent.body.data!.message.id },
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });
});

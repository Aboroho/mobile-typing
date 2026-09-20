/**
 * Authenticated WebSocket server, exercised over a real socket.
 *
 * Covers the rules that matter for privacy and for reconnects:
 *  - no session cookie → the handshake is refused;
 *  - a client cannot subscribe to a conversation it is not a member of;
 *  - a frame rendered for the other participant is never forwarded;
 *  - missed durable events are replayed from the outbox on reconnect;
 *  - a typing frame is republished with the authenticated sender id;
 *  - heartbeat answers `ping`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket } from 'ws';
import { POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { createKeypadWSServer, type KeypadWSServer } from '@/lib/ws/server';
import { getData } from '@/lib/data';
import { topics } from '@/lib/realtime/bus';
import { publishEvent } from '@/lib/realtime/outbox';
import { jsonRequest, registerUser, resetState, type TestUser } from '../helpers/api';

let httpServer: Server;
let wsServer: KeypadWSServer;
let port = 0;

interface WireFrame {
  id?: string;
  topic: string;
  type: string;
  payload: Record<string, unknown>;
}

beforeAll(async () => {
  httpServer = createServer();
  wsServer = createKeypadWSServer({ path: '/api/v1/ws' });
  httpServer.on('upgrade', (req, socket, head) => {
    wsServer.handleUpgrade(req, socket as unknown as Socket, head);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  resetState();
});

function connect(cookie: string | null, query = ''): Promise<{ socket: WebSocket; frames: WireFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws${query}`, {
      headers: cookie ? { cookie } : {},
    });
    const frames: WireFrame[] = [];
    socket.on('message', (raw) => {
      try {
        frames.push(JSON.parse(raw.toString('utf8')) as WireFrame);
      } catch {
        /* ignore */
      }
    });
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('unexpected-response', (_req, res) => reject(new Error(`handshake refused: ${res.statusCode}`)));
    socket.on('error', (error) => reject(error));
  });
}

function waitFor(frames: WireFrame[], predicate: (frame: WireFrame) => boolean, timeoutMs = 3000): Promise<WireFrame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = frames.find(predicate);
      if (found) {
        clearInterval(tick);
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for a frame; received: ${JSON.stringify(frames.map((f) => f.type))}`));
      }
    }, 10);
  });
}

async function startConversation(alice: TestUser, bob: TestUser): Promise<string> {
  const response = await createConversationRoute(
    jsonRequest('POST', '/api/v1/conversations', { participantId: bob.id }, alice.jar),
  );
  const body = (await response.json()) as { data?: { conversation: { conversation: { id: string } } } };
  if (!body.data) throw new Error('conversation creation failed');
  return body.data.conversation.conversation.id;
}

describe('websocket server', () => {
  beforeEach(() => resetState());

  it('refuses the handshake without a session cookie', async () => {
    await expect(connect(null)).rejects.toThrow(/401/);
  });

  it('accepts an authenticated client and greets it', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const { socket, frames } = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    const hello = await waitFor(frames, (frame) => frame.type === 'hello');
    expect(hello.payload['userId']).toBe(alice.id);
    socket.close();
  });

  it('refuses a subscription to a conversation the user is not a member of', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const carol = await registerUser({ name: 'Carol', email: 'carol@example.com' });
    const cid = await startConversation(alice, bob);

    const { socket, frames } = await connect(`mt_session=${carol.jar.cookies['mt_session']}`);
    socket.send(JSON.stringify({ type: 'subscribe', conversations: [cid] }));
    const subscribed = await waitFor(frames, (frame) => frame.type === 'subscribed');
    expect(subscribed.payload['refused']).toEqual([cid]);
    expect(subscribed.payload['conversations']).toEqual([]);

    // And nothing reaches her when the participants talk.
    await publishEvent({
      topic: topics.messages(cid),
      type: 'message.created',
      recipients: [
        { userId: alice.id, payload: { conversationId: cid, message: { id: 'm1', text: 'secret' }, forUserId: alice.id } },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames.some((frame) => frame.type === 'message.created')).toBe(false);
    socket.close();
  });

  it('delivers events only to the participant they were rendered for', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await startConversation(alice, bob);

    const aliceSocket = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    const bobSocket = await connect(`mt_session=${bob.jar.cookies['mt_session']}`);
    aliceSocket.socket.send(JSON.stringify({ type: 'subscribe', conversations: [cid] }));
    bobSocket.socket.send(JSON.stringify({ type: 'subscribe', conversations: [cid] }));
    await waitFor(aliceSocket.frames, (frame) => frame.type === 'subscribed');
    await waitFor(bobSocket.frames, (frame) => frame.type === 'subscribed');

    // One recipient only: Bob. Alice is subscribed to the same topic, so this
    // is exactly the case where a missing filter would leak the frame to her.
    await publishEvent({
      topic: topics.messages(cid),
      type: 'message.created',
      recipients: [
        { userId: bob.id, payload: { conversationId: cid, message: { id: 'm_for_bob' }, forUserId: bob.id } },
      ],
    });

    const forBob = await waitFor(bobSocket.frames, (frame) => frame.type === 'message.created');
    expect(forBob.payload['message']).toMatchObject({ id: 'm_for_bob' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(aliceSocket.frames.filter((frame) => frame.type === 'message.created')).toHaveLength(0);

    // The mirror image: a payload rendered for Alice must not reach Bob.
    await publishEvent({
      topic: topics.messages(cid),
      type: 'message.created',
      recipients: [
        { userId: alice.id, payload: { conversationId: cid, message: { id: 'm_for_alice' }, forUserId: alice.id } },
      ],
    });
    await waitFor(aliceSocket.frames, (frame) => frame.type === 'message.created');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bobSocket.frames.filter((frame) => frame.type === 'message.created')).toHaveLength(1);

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  it('replays missed durable events on reconnect using the since cursor', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await startConversation(alice, bob);

    // Published while Alice is offline: only the outbox rows exist.
    await publishEvent({
      topic: topics.messages(cid),
      type: 'message.created',
      recipients: [{ userId: alice.id, payload: { conversationId: cid, message: { id: 'missed_1' }, forUserId: alice.id } }],
    });
    await publishEvent({
      topic: topics.messages(cid),
      type: 'message.created',
      recipients: [{ userId: alice.id, payload: { conversationId: cid, message: { id: 'missed_2' }, forUserId: alice.id } }],
    });

    const { socket, frames } = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    socket.send(JSON.stringify({ type: 'subscribe', conversations: [cid] }));
    const subscribed = await waitFor(frames, (frame) => frame.type === 'subscribed');
    expect(subscribed.payload['replayed']).toBeGreaterThanOrEqual(2);

    const replayed = frames.filter((frame) => frame.type === 'message.created');
    expect(replayed.map((frame) => (frame.payload['message'] as { id: string }).id).sort()).toEqual([
      'missed_1',
      'missed_2',
    ]);
    socket.close();
  });

  it('republishes a typing frame with the authenticated sender id', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await startConversation(alice, bob);

    const aliceSocket = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    const bobSocket = await connect(`mt_session=${bob.jar.cookies['mt_session']}`);
    aliceSocket.socket.send(JSON.stringify({ type: 'subscribe', conversations: [cid] }));
    bobSocket.socket.send(JSON.stringify({ type: 'subscribe', conversations: [cid] }));
    await waitFor(aliceSocket.frames, (frame) => frame.type === 'subscribed');
    await waitFor(bobSocket.frames, (frame) => frame.type === 'subscribed');

    // Alice claims to be Bob: the server must stamp the real sender.
    aliceSocket.socket.send(JSON.stringify({ type: 'typing', conversationId: cid, isTyping: true }));
    const typing = await waitFor(bobSocket.frames, (frame) => frame.type === 'typing');
    expect(typing.payload['userId']).toBe(alice.id);
    expect(typing.payload['otherUserId']).toBe(bob.id);

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  it('answers ping with pong', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const { socket, frames } = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitFor(frames, (frame) => frame.type === 'pong');
    expect(pong.topic).toBe('system');
    socket.close();
  });

  it('rejects a malformed frame without dropping the connection', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const { socket, frames } = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    socket.send('this is not json');
    const error = await waitFor(frames, (frame) => frame.type === 'error');
    expect(error.payload['code']).toBe('BAD_FRAME');
    socket.send(JSON.stringify({ type: 'ping' }));
    await waitFor(frames, (frame) => frame.type === 'pong');
    socket.close();
  });

  it('counts multiple sessions per user', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const first = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    const second = await connect(`mt_session=${alice.jar.cookies['mt_session']}`);
    await waitFor(first.frames, (frame) => frame.type === 'hello');
    await waitFor(second.frames, (frame) => frame.type === 'hello');
    expect(wsServer.clientsFor(alice.id)).toBe(2);
    first.socket.close();
    second.socket.close();
  });

  it('keeps the durable outbox row for every recipient', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const data = await getData();
    await publishEvent({
      topic: topics.messages('c_x'),
      type: 'message.created',
      recipients: [
        { userId: alice.id, payload: { forUserId: alice.id } },
        { userId: bob.id, payload: { forUserId: bob.id } },
      ],
    });
    expect((await data.outbox.listForUser(alice.id, null, 10)).length).toBe(1);
    expect((await data.outbox.listForUser(bob.id, null, 10)).length).toBe(1);
  });
});

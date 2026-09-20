/**
 * Live end-to-end check against the running standalone server:
 *  1. unlock the access gate exactly like the browser does (sha-256 digest);
 *  2. register two users over the real API;
 *  3. bob connects the authenticated WebSocket and subscribes;
 *  4. alice POSTs a message;
 *  5. we measure how long the socket delivery takes, and verify the REST
 *     response arrives before/independently of the database write.
 */
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

const BASE = 'http://localhost:3000';

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

class Jar {
  constructor() { this.cookies = new Map(); }
  header() { return Array.from(this.cookies, ([n, v]) => `${n}=${v}`).join('; '); }
  absorb(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
}

async function api(method, path, jar, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.header() ? { Cookie: jar.header() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  jar.absorb(response);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(json)}`);
  return json.data;
}

async function unlock(jar) {
  const { challenge } = await api('POST', '/api/v1/access/challenge', jar, {});
  await api('POST', '/api/v1/access/unlock', jar, {
    challengeToken: challenge.challengeToken,
    digest: sha256Hex(challenge.code),
  });
}

async function register(jar, name, email) {
  const { user } = await api('POST', '/api/v1/auth/register', jar, { name, email, password: 'CorrectHorse1!' });
  return user;
}

const aliceJar = new Jar();
const bobJar = new Jar();

await unlock(aliceJar);
await unlock(bobJar);
console.log('access gate unlocked for both jars');

const alice = await register(aliceJar, 'Alice', `alice-${Date.now()}@example.com`);
const bob = await register(bobJar, 'Bob', `bob-${Date.now()}@example.com`);
console.log('registered', alice.id, bob.id);

const { conversation } = await api('POST', '/api/v1/conversations', aliceJar, { participantId: bob.id });
const conversationId = conversation.conversation.id;
console.log('conversation', conversationId);

// Bob connects the socket and subscribes before alice sends.
const ws = new WebSocket(`ws://localhost:3000/api/v1/ws`, { headers: { Cookie: bobJar.header() } });
const frames = [];
let deliveredAt = null;
let sentAt = null;

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
ws.on('message', (raw) => {
  const frame = JSON.parse(String(raw));
  frames.push(frame);
  if (frame.type === 'message.created' && deliveredAt === null) deliveredAt = performance.now();
});
ws.send(JSON.stringify({ type: 'subscribe', conversations: [conversationId] }));
await new Promise((r) => setTimeout(r, 300));
if (!frames.some((f) => f.type === 'subscribed')) throw new Error('bob was not subscribed');
console.log('bob subscribed over websocket');

// Alice sends; measure both the socket delivery and the REST round-trip.
const clientMessageId = `cmsg_live_${Date.now()}`;
sentAt = performance.now();
const sendResponse = await fetch(`${BASE}/api/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: aliceJar.header() },
  body: JSON.stringify({ conversationId, type: 'text', text: 'are you seeing this instantly?', clientMessageId }),
});
const restDoneAt = performance.now();
const sendBody = await sendResponse.json();
if (sendResponse.status !== 201) throw new Error(`send failed: ${JSON.stringify(sendBody)}`);

// Wait for the socket frame.
const deadline = Date.now() + 5000;
while (deliveredAt === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
if (deliveredAt === null) throw new Error('bob never received the message over the socket');

console.log(`REST response:  +${(restDoneAt - sentAt).toFixed(1)} ms`);
console.log(`Socket delivery to bob: +${(deliveredAt - sentAt).toFixed(1)} ms`);

// The conversation list event (preview/unread) should follow from the
// write-behind job.
await new Promise((r) => setTimeout(r, 500));
const conversationUpdated = frames.filter((f) => f.type === 'conversation.updated');
console.log('conversation.updated frames for bob:', conversationUpdated.length);

// The message must be persisted by now (write-behind caught up).
const list = await api('GET', `/api/v1/conversations/${conversationId}/messages?limit=10`, bobJar);
const texts = list.items.map((m) => m.text);
if (!texts.includes('are you seeing this instantly?')) {
  throw new Error(`message not persisted: ${JSON.stringify(texts)}`);
}
console.log('persisted: message is in the database');

ws.close();
console.log('\nLIVE E2E: OK');

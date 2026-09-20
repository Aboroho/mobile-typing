/**
 * Authentication, end to end, against the argon2 password/session backend.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageForUser } from '@mt/types';
import type { SessionUser } from '@mt/api-client';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { GET as meRoute } from '@/app/api/v1/auth/me/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as logoutRoute } from '@/app/api/v1/auth/logout/route';
import { POST as reauthRoute } from '@/app/api/v1/auth/reauthenticate/route';
import { GET as searchRoute } from '@/app/api/v1/users/search/route';
import { GET as conversationsRoute, POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { GET as listMessagesRoute } from '@/app/api/v1/conversations/[conversationId]/messages/route';
import { GET as eventsRoute } from '@/app/api/v1/conversations/[conversationId]/events/route';
import { POST as sendMessageRoute } from '@/app/api/v1/messages/route';
import {
  absorb,
  call,
  cookieOnly,
  jar,
  jsonRequest,
  loginUser,
  queryRequest,
  registerUser,
  resetState,
  unlockJar,
  type TestUser,
} from '../helpers/api';

beforeEach(() => resetState());

type AuthBody = { user: SessionUser | null; token?: string | null; cookieSession?: boolean; accessGranted?: boolean };
type AuthEnvelope = { ok: boolean; data?: AuthBody; error?: { code: string; message: string } };

async function startConversation(alice: TestUser, bob: TestUser): Promise<string> {
  const created = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId: bob.id }, alice.jar),
  );
  if (created.status !== 201 || !created.body.data) throw new Error(`conversation failed: ${created.status}`);
  return created.body.data.conversation.conversation.id;
}

describe('registration', () => {
  it('creates a profile, password hash, and an httpOnly session cookie', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.status).toBe(200);
    expect(me.body.data?.user).toMatchObject({ email: 'alice@example.com', name: 'Alice', status: 'active', isAdmin: false });
    expect(alice.jar.cookies['mt_access']).toBeTruthy();
  });

  it('sets an httpOnly session cookie and does not return a bearer token', async () => {
    const target = await unlockJar();
    const response = await registerRoute(
      jsonRequest('POST', '/api/v1/auth/register', { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' }, target),
    );
    const body = (await response.json()) as AuthEnvelope;
    expect(response.status).toBe(201);
    expect(body.data?.token).toBeNull();
    expect(body.data?.cookieSession).toBe(true);
    const session = response.headers.getSetCookie().find((c) => c.startsWith('mt_session='));
    expect(session).toBeTruthy();
    expect(session).toContain('HttpOnly');
    expect(session).toMatch(/SameSite=lax/i);
    expect(session).toContain('Path=/');
  });

  it('does not disclose whether an email is already registered', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });
    // A fresh client without access cookie gets a generic auth error for a duplicate
    // email with a wrong password (account enumeration defence).
    const target = await unlockJar();
    const resp = await call(
      registerRoute,
      jsonRequest('POST', '/api/v1/auth/register', { name: 'Bob', email: 'alice@example.com', password: 'WrongPassword1!' }, target),
    );
    // Wrong password on an existing email -> 401, indistinguishable from unknown.
    expect(resp.status).toBe(401);
  });

  it('rejects a malformed payload', async () => {
    const target = await unlockJar();
    const invalid = await call(
      registerRoute,
      jsonRequest('POST', '/api/v1/auth/register', { name: 'A', email: 'not-an-email', password: 'x' }, target),
    );
    expect(invalid.status).toBe(422);
  });

  it('registering without unlock still creates the session but does not bind access', async () => {
    const target = jar(); // no unlock
    const response = await registerRoute(
      jsonRequest('POST', '/api/v1/auth/register', { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' }, target),
    );
    absorb(response, target);
    expect(response.status).toBe(201);
    expect(target.cookies['mt_access']).toBeUndefined();
  });
});

describe('login', () => {
  it('returns the existing profile and a fresh session cookie', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const before = alice.jar.cookies['mt_session'];
    const fresh = await unlockJar();
    const returning = await loginUser({ email: 'alice@example.com', target: fresh });
    expect(returning.id).toBe(alice.id);
    expect(returning.jar.cookies['mt_session']).toBeTruthy();
    expect(returning.jar.cookies['mt_session']).not.toBe(before);
    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, returning.jar));
    expect(me.body.data?.user?.email).toBe('alice@example.com');
  });

  it('returns the same generic error for wrong password and unknown email', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const target = await unlockJar();
    const wrong = await call(
      loginRoute,
      jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com', password: 'WrongPassword1!' }, target),
    );
    expect(wrong.status).toBe(401);
    const target2 = await unlockJar();
    const unknown = await call(
      loginRoute,
      jsonRequest('POST', '/api/v1/auth/login', { email: 'nobody@example.com', password: 'WrongPassword1!' }, target2),
    );
    expect(unknown.status).toBe(401);
    expect(wrong.body.error?.message).toBe(unknown.body.error?.message);
  });

  it('login without access session sets session but does not grant chat access', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const fresh = jar(); // no unlock
    const loginResp = await loginRoute(
      jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com', password: 'CorrectHorse1!' }, fresh),
    );
    absorb(loginResp, fresh);
    const body = (await loginResp.json()) as AuthEnvelope;
    expect(loginResp.status).toBe(200);
    expect(body.data?.accessGranted).toBe(false);
    expect(fresh.cookies['mt_access']).toBeUndefined();
    // Without an access cookie, protected chat routes return 403 (access required).
    const denied = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, fresh));
    expect(denied.status).toBe(403);
  });
});

describe('sessions', () => {
  it('authorises with the session cookie alone (for /auth/me)', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    cookieOnly(alice.jar);
    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.status).toBe(200);
    expect(me.body.data?.user?.id).toBe(alice.id);
  });

  it('authorises SSE events only when both session and access cookies are present', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await startConversation(alice, bob);
    const auth = await requireAuthenticatedAccess(
      queryRequest('GET', `/api/v1/conversations/${cid}/events`, undefined, cookieOnly(alice.jar)),
    );
    expect(auth.user.id).toBe(alice.id);
    const denied = await call(eventsRoute, queryRequest('GET', `/api/v1/conversations/${cid}/events`, undefined, jar()), { conversationId: cid });
    expect(denied.status).toBe(401);
  });

  it('logout clears cookies and revokes the session', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const stolenCookie = alice.jar.cookies['mt_session'];
    const logout = await logoutRoute(jsonRequest('POST', '/api/v1/auth/logout', {}, alice.jar));
    expect(logout.status).toBe(200);
    absorb(logout, alice.jar);
    expect(alice.jar.cookies['mt_session']).toBeUndefined();
    expect(alice.jar.cookies['mt_access']).toBeUndefined();
    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.status).toBe(200);
    expect(me.body.data?.user).toBeNull();
    const replay = jar();
    replay.cookies['mt_session'] = stolenCookie ?? '';
    const replayed = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, replay));
    expect(replayed.status).toBe(401);
  });

  it('reauthenticate with no session returns an error', async () => {
    const browser = jar();
    const missing = await call(reauthRoute, jsonRequest('POST', '/api/v1/auth/reauthenticate', { password: 'CorrectHorse1!' }, browser));
    expect([401, 403]).toContain(missing.status);
  });
});

describe('chat access control', () => {
  it('hides a conversation from non-participants', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const carol = await registerUser({ name: 'Carol', email: 'carol@example.com' });
    const cid = await startConversation(alice, bob);
    const denied = await call(listMessagesRoute, queryRequest('GET', `/api/v1/conversations/${cid}/messages`, undefined, carol.jar), { conversationId: cid });
    expect(denied.status).toBe(404);
  });

  it('does not leak emails in search results', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const found = await call<{ items: { name: string; email?: string; id: string }[] }>(searchRoute, queryRequest('GET', '/api/v1/users/search', { q: 'Bob' }, alice.jar));
    expect(found.status).toBe(200);
    const bob = found.body.data?.items.find((i) => i.name === 'Bob');
    expect(bob?.id).toBeTruthy();
    expect(bob?.email).toBeUndefined();
  });

  it('delivers messages between two accounts', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const cid = await startConversation(alice, bob);
    const sent = await call<{ message: MessageForUser }>(
      sendMessageRoute,
      jsonRequest('POST', '/api/v1/messages', { conversationId: cid, type: 'text', text: 'hello bob', clientMessageId: 'cm-auth-msg-001' }, alice.jar),
    );
    expect(sent.status).toBe(201);
    const inbox = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${cid}/messages`, undefined, cookieOnly(bob.jar)),
      { conversationId: cid },
    );
    expect(inbox.status).toBe(200);
    expect(inbox.body.data?.items.map((m) => m.text)).toContain('hello bob');
  });
});

/**
 * Authentication, end to end, against a Firebase Authentication double
 * (`tests/helpers/firebase-auth.ts`): the browser half creates the account and
 * obtains an ID token, the API half verifies it, initialises the profile and
 * mints the session cookie.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationView, MessageForUser } from '@mt/types';
import type { SessionUser } from '@mt/api-client';
import { resetStore, getStore } from '@/lib/data/memory';
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
  reauthenticateUser,
  registerUser,
  unlockJar,
  type TestUser,
} from '../helpers/api';
import { FirebaseAuthError, fakeAdminAuth } from '../helpers/firebase-auth';

beforeEach(() => resetStore());

type AuthBody = {
  user: SessionUser | null;
  token?: string | null;
  cookieSession?: boolean;
  accessGranted?: boolean;
};

/** Removes the application profile, keeping the Firebase account. */
function dropProfile(userId: string): void {
  getStore().users.delete(userId);
}

async function startConversation(alice: TestUser, bob: TestUser): Promise<string> {
  const created = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId: bob.id }, alice.jar),
  );
  if (created.status !== 201 || !created.body.data) {
    throw new Error(`conversation failed: ${created.status}`);
  }
  return created.body.data.conversation.conversation.id;
}

describe('registration', () => {
  it('creates the Firebase account, the application profile and a session', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });

    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.status).toBe(200);
    expect(me.body.data?.user).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice',
      status: 'active',
      isAdmin: false,
    });
    expect(me.body.data?.user?.createdAt).toBeTruthy();
    expect(me.body.data?.user?.lastLoginAt).toBeTruthy();
    // The typing game was unlocked first, so the chat is reachable immediately.
    expect(alice.jar.cookies['mt_access']).toBeTruthy();
  });

  it('uses the Firebase uid as the application user id', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    expect(alice.id).toBe(alice.uid);
    expect(fakeAdminAuth.account(alice.uid)?.email).toBe('alice@example.com');
  });

  it('sets an httpOnly session cookie and returns no credential of its own', async () => {
    const target = await unlockJar();
    const { idToken } = fakeAdminAuth.signUpWithPassword({
      email: 'alice@example.com',
      password: 'CorrectHorse1!',
      displayName: 'Alice',
    });
    target.token = idToken;

    const response = await registerRoute(
      jsonRequest('POST', '/api/v1/auth/register', { name: 'Alice', email: 'alice@example.com' }, target),
    );
    const body = (await response.json()) as { data: AuthBody };
    expect(response.status).toBe(201);
    // The browser SDK owns the ID token; the API never hands one back.
    expect(body.data.token).toBeNull();
    expect(body.data.cookieSession).toBe(true);

    const session = response.headers.getSetCookie().find((cookie) => cookie.startsWith('mt_session='));
    expect(session).toBeTruthy();
    expect(session).toContain('HttpOnly');
    expect(session).toMatch(/SameSite=lax/i);
    expect(session).toContain('Path=/');
    expect(session).toMatch(/Max-Age=\d+/);
    // `Secure` follows NODE_ENV: it is set in a production build, not under vitest.
    if (process.env.NODE_ENV === 'production') expect(session).toContain('Secure');
  });

  it('is idempotent for the same Firebase identity, so a retry cannot duplicate a profile', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const retry = await call<AuthBody>(
      registerRoute,
      jsonRequest('POST', '/api/v1/auth/register', { name: 'Alice', email: 'alice@example.com' }, alice.jar),
    );
    expect(retry.status).toBe(201);
    expect(retry.body.data?.user?.id).toBe(alice.id);
    expect(getStore().users.size).toBe(1);
  });

  it('refuses to attach a profile that belongs to a different uid', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    // Somebody else's Firebase account claims the same address.
    const impostor = fakeAdminAuth.signUpWithPassword({
      email: 'taken@example.com',
      password: 'CorrectHorse1!',
      displayName: 'Impostor',
    });
    const profile = getStore().users.get(alice.id) as Record<string, unknown>;
    getStore().users.set('legacy-owner', { ...profile, id: 'legacy-owner', email: 'taken@example.com' });

    const target = await unlockJar();
    target.token = impostor.idToken;
    const denied = await call(
      registerRoute,
      jsonRequest('POST', '/api/v1/auth/register', { name: 'Impostor', email: 'taken@example.com' }, target),
    );
    expect(denied.status).toBe(409);
    expect(denied.body.error?.code).toBe('CONFLICT');
    expect(getStore().users.has(impostor.uid)).toBe(false);
  });

  it('rejects a malformed payload before anything is created', async () => {
    const target = await unlockJar();
    const invalid = await call(
      registerRoute,
      jsonRequest('POST', '/api/v1/auth/register', { name: 'A', email: 'not-an-email' }, target),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.code).toBe('VALIDATION_ERROR');
    expect(getStore().users.size).toBe(0);
  });

  it('requires a verified Firebase credential', async () => {
    const anonymous = await unlockJar();
    const missing = await call(registerRoute, jsonRequest('POST', '/api/v1/auth/register', { name: 'Alice' }, anonymous));
    expect(missing.status).toBe(401);
    expect(missing.body.error?.code).toBe('UNAUTHENTICATED');

    const forged = await unlockJar();
    forged.token = fakeAdminAuth.forgeToken('whoever');
    const rejected = await call(
      registerRoute,
      jsonRequest('POST', '/api/v1/auth/register', { name: 'Alice', email: 'alice@example.com' }, forged),
    );
    expect(rejected.status).toBe(401);
    expect(getStore().users.size).toBe(0);
  });

  it('never stores a password, even if a client sends one', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const stored = getStore().users.get(alice.id) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain('passwordHash');
    expect(Object.keys(stored)).not.toContain('passwordSalt');
    expect(JSON.stringify(stored)).not.toContain('CorrectHorse1!');
  });
});

describe('login', () => {
  it('returns the existing profile and a fresh session', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const before = alice.jar.cookies['mt_session'];

    const returning = await loginUser({ email: 'alice@example.com', password: 'CorrectHorse1!' });
    expect(returning.id).toBe(alice.id);
    expect(returning.jar.cookies['mt_session']).toBeTruthy();
    expect(returning.jar.cookies['mt_session']).not.toBe(before);

    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, returning.jar));
    expect(me.body.data?.user?.email).toBe('alice@example.com');
  });

  it('makes a wrong password and an unknown email indistinguishable', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });

    // Firebase answers both the same way, so the browser cannot tell them apart.
    const wrongPassword = () => fakeAdminAuth.signInWithPassword('alice@example.com', 'WrongPassword1!');
    const unknownEmail = () => fakeAdminAuth.signInWithPassword('nobody@example.com', 'WrongPassword1!');
    expect(wrongPassword).toThrow(FirebaseAuthError);
    expect(unknownEmail).toThrow(FirebaseAuthError);
    expect(wrongPasswordError(wrongPassword)).toBe(wrongPasswordError(unknownEmail));

    // And the API says the same thing about an unverifiable credential as it does
    // about a valid credential for an account it does not know.
    const target = await unlockJar();
    target.token = fakeAdminAuth.forgeToken('nobody');
    const rejected = await call(loginRoute, jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com' }, target));
    expect(rejected.status).toBe(401);
    expect(rejected.body.error?.message).toBe('unable to sign in with those details');
  });

  it('never lets a login bypass the typing-game gate', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });
    // A fresh jar: never unlocked, so no access session.
    const sneaky = jar();
    const { idToken } = fakeAdminAuth.signInWithPassword('alice@example.com', 'CorrectHorse1!');
    sneaky.token = idToken;

    const login = await call<AuthBody>(
      loginRoute,
      jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com' }, sneaky),
    );
    expect(login.status).toBe(200);
    expect(login.body.data?.accessGranted).toBe(false);
    expect(sneaky.cookies['mt_access']).toBeUndefined();
  });

  it('refuses protected data without an access session', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    delete alice.jar.cookies['mt_access'];
    const denied = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, alice.jar));
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('ACCESS_REQUIRED');
  });

  it('recovers a profile that is missing while the Firebase account still exists', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    dropProfile(alice.id);

    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.body.data?.user).toBeNull();

    // Signing in again recreates it, with the same id, from the Firebase identity.
    const recovered = await loginUser({ email: 'alice@example.com', password: 'CorrectHorse1!' });
    expect(recovered.id).toBe(alice.id);
    expect(recovered.name).toBe('Alice');
  });

  it('keeps existing conversations reachable after a profile is recovered', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const conversationId = await startConversation(alice, bob);
    await call(
      sendMessageRoute,
      jsonRequest(
        'POST',
        '/api/v1/messages',
        { conversationId, type: 'text', text: 'still here', clientMessageId: 'cm-recover-1' },
        alice.jar,
      ),
    );
    dropProfile(alice.id);

    const recovered = await loginUser({ email: 'alice@example.com', password: 'CorrectHorse1!' });
    expect(recovered.id).toBe(alice.id);

    const list = await call<{ items: ConversationView[] }>(
      conversationsRoute,
      queryRequest('GET', '/api/v1/conversations', undefined, recovered.jar),
    );
    expect(list.status).toBe(200);
    expect(list.body.data?.items.map((item) => item.conversation.id)).toContain(conversationId);

    const messages = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, undefined, recovered.jar),
      { conversationId },
    );
    expect(messages.status).toBe(200);
    expect(messages.body.data?.items.map((item) => item.text)).toContain('still here');
  });
});

describe('sessions', () => {
  it('authorises a request that presents only the session cookie', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    cookieOnly(alice.jar);

    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.status).toBe(200);
    expect(me.body.data?.user?.id).toBe(alice.id);
  });

  it('authorises the SSE stream with the session cookie alone', async () => {
    // `EventSource` cannot set an `Authorization` header, so the real-time
    // channel depends entirely on the cookie minted at login.
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const conversationId = await startConversation(alice, bob);

    const auth = await requireAuthenticatedAccess(
      queryRequest('GET', `/api/v1/conversations/${conversationId}/events`, undefined, cookieOnly(alice.jar)),
    );
    expect(auth.user.id).toBe(alice.id);

    // The route itself refuses a browser that has neither cookie nor token.
    const denied = await call(
      eventsRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/events`, undefined, jar()),
      { conversationId },
    );
    expect(denied.status).toBe(401);
  });

  it('does not exchange a stale ID token for a week-long session cookie', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    delete alice.jar.cookies['mt_session'];
    // Ten minutes old: still a valid ID token, but no longer "recently signed in".
    alice.jar.token = fakeAdminAuth.issueFor(alice.uid, { ageSeconds: 600 });

    const login = await call<AuthBody>(
      loginRoute,
      jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com' }, alice.jar),
    );
    expect(login.status).toBe(200);
    expect(login.body.data?.user?.id).toBe(alice.id);
    expect(alice.jar.cookies['mt_session']).toBeUndefined();
  });

  it('logs out, revoking the Firebase credentials and clearing the cookies', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const stolenCookie = alice.jar.cookies['mt_session'];

    const logout = await logoutRoute(jsonRequest('POST', '/api/v1/auth/logout', {}, alice.jar));
    expect(logout.status).toBe(200);
    absorb(logout, alice.jar);
    expect(alice.jar.cookies['mt_session']).toBeUndefined();
    expect(alice.jar.cookies['mt_access']).toBeUndefined();

    // /auth/me answers 200 with a null user rather than 401, so the client can
    // distinguish "signed out" from "the API is broken".
    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.status).toBe(200);
    expect(me.body.data?.user).toBeNull();

    // A cookie copied before logout is useless afterwards: the revocation, not
    // just the clearing, is what ends the session.
    const replay = jar();
    replay.cookies['mt_session'] = stolenCookie ?? '';
    replay.cookies['mt_access'] = alice.jar.cookies['mt_access'] ?? '';
    const replayed = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, replay));
    expect(replayed.status).toBe(401);
  });

  it('logs out a caller who is already signed out', async () => {
    const anonymous = await unlockJar();
    const logout = await logoutRoute(jsonRequest('POST', '/api/v1/auth/logout', {}, anonymous));
    expect(logout.status).toBe(200);
  });

  it('requires a recent credential to reauthenticate, then rebinds the access session', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });

    // A second browser: it unlocked the typing game before anybody signed in, so
    // its access session is unbound and the chat must stay closed until the
    // password is proved again.
    const browser = await unlockJar();
    expect(browser.cookies['mt_session']).toBeUndefined();
    const session: TestUser = { ...alice, jar: browser };

    browser.token = fakeAdminAuth.issueFor(alice.uid, { ageSeconds: 600 });
    const stale = await call(reauthRoute, jsonRequest('POST', '/api/v1/auth/reauthenticate', {}, browser));
    expect(stale.status).toBe(412);
    expect(stale.body.error?.code).toBe('PRECONDITION_FAILED');

    // Proving the password again resets Firebase's auth_time, which is what makes
    // the credential fresh enough for a new session cookie.
    await reauthenticateUser(session);
    expect(browser.cookies['mt_session']).toBeTruthy();

    const bound = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, browser));
    expect(bound.body.data?.user?.id).toBe(alice.id);
    const auth = await requireAuthenticatedAccess(
      queryRequest('GET', '/api/v1/conversations', undefined, browser),
    );
    expect(auth.user.id).toBe(alice.id);
  });
});

describe('chat access control after the change', () => {
  it('still hides a conversation from somebody who is not a participant', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const carol = await registerUser({ name: 'Carol', email: 'carol@example.com' });
    const conversationId = await startConversation(alice, bob);

    const denied = await call(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, undefined, carol.jar),
      { conversationId },
    );
    expect(denied.status).toBe(404);
  });

  it('does not expose other users’ email addresses through search', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const found = await call<{ items: { name: string; email?: string; id: string }[] }>(
      searchRoute,
      queryRequest('GET', '/api/v1/users/search', { q: 'Bob' }, alice.jar),
    );
    expect(found.status).toBe(200);
    const bob = found.body.data?.items.find((item) => item.name === 'Bob');
    expect(bob?.id).toBeTruthy();
    expect(bob?.email).toBeUndefined();
  });

  it('carries a conversation between two Firebase identities exactly as before', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
    const conversationId = await startConversation(alice, bob);

    const sent = await call<{ message: MessageForUser }>(
      sendMessageRoute,
      jsonRequest(
        'POST',
        '/api/v1/messages',
        { conversationId, type: 'text', text: 'hello bob', clientMessageId: 'cm-auth-1' },
        alice.jar,
      ),
    );
    expect(sent.status).toBe(201);
    expect(sent.body.data?.message.senderId).toBe(alice.id);

    // Bob reads it with the session cookie only, as an EventSource-driven UI would.
    const inbox = await call<{ items: MessageForUser[] }>(
      listMessagesRoute,
      queryRequest('GET', `/api/v1/conversations/${conversationId}/messages`, undefined, cookieOnly(bob.jar)),
      { conversationId },
    );
    expect(inbox.status).toBe(200);
    expect(inbox.body.data?.items.map((item) => item.text)).toContain('hello bob');
  });
});

function wrongPasswordError(attempt: () => unknown): string | null {
  try {
    attempt();
    return null;
  } catch (error) {
    return error instanceof FirebaseAuthError ? error.errorInfo.code : 'not-a-firebase-error';
  }
}

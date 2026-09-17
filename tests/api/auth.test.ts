import { beforeEach, describe, expect, it } from 'vitest';
import { resetStore } from '@/lib/data/memory';
import { GET as meRoute } from '@/app/api/v1/auth/me/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as logoutRoute } from '@/app/api/v1/auth/logout/route';
import { POST as reauthRoute } from '@/app/api/v1/auth/reauthenticate/route';
import { POST as resetRoute } from '@/app/api/v1/auth/password-reset/route';
import { GET as searchRoute } from '@/app/api/v1/users/search/route';
import { GET as conversationsRoute } from '@/app/api/v1/conversations/route';
import { absorb, call, jar, jsonRequest, queryRequest, registerUser, unlockJar } from '../helpers/api';

beforeEach(() => resetStore());

describe('authentication', () => {
  it('registers a user and returns a session that /auth/me accepts', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const me = await call<{ user: { email: string; id: string } }>(
      meRoute,
      queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar),
    );
    expect(me.status).toBe(200);
    expect(me.body.data?.user.email).toBe('alice@example.com');
    expect(me.body.data?.user.id).toBe(alice.id);
  });

  it('refuses to register the same email twice, with a message that leaks nothing', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const target = await unlockJar();
    const duplicate = await call(
      registerRoute,
      jsonRequest(
        'POST',
        '/api/v1/auth/register',
        { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!', confirmPassword: 'CorrectHorse1!' },
        target,
      ),
    );
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.body.error?.message.toLowerCase()).not.toContain('already');
  });

  it('rejects a wrong password with the same error as an unknown email', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const target = await unlockJar();
    const wrongPassword = await call(
      loginRoute,
      jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com', password: 'WrongPassword1!' }, target),
    );
    const unknown = await call(
      loginRoute,
      jsonRequest('POST', '/api/v1/auth/login', { email: 'nobody@example.com', password: 'WrongPassword1!' }, target),
    );
    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPassword.body.error?.message).toBe(unknown.body.error?.message);
  });

  it('never lets a login bypass the typing-game gate', async () => {
    await registerUser({ name: 'Alice', email: 'alice@example.com' });
    // A fresh jar: never unlocked, so no access session.
    const sneaky = jar();
    const login = await call<{ accessGranted: boolean }>(
      loginRoute,
      jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com', password: 'CorrectHorse1!' }, sneaky),
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

  it('logs out and invalidates the session', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const logout = await logoutRoute(jsonRequest('POST', '/api/v1/auth/logout', {}, alice.jar));
    expect(logout.status).toBe(200);
    absorb(logout, alice.jar);
    // /auth/me answers 200 with a null user rather than 401, so the client can
    // distinguish "signed out" from "the API is broken".
    const me = await call<{ user: unknown }>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, alice.jar));
    expect(me.status).toBe(200);
    expect(me.body.data?.user).toBeNull();
  });

  it('requires the password again for reauthentication', async () => {
    const alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
    const bad = await call(reauthRoute, jsonRequest('POST', '/api/v1/auth/reauthenticate', { password: 'nope-nope' }, alice.jar));
    expect(bad.status).toBe(401);
    const good = await call(reauthRoute, jsonRequest('POST', '/api/v1/auth/reauthenticate', { password: 'CorrectHorse1!' }, alice.jar));
    expect(good.status).toBe(200);
  });

  it('always answers a password reset request the same way', async () => {
    const target = await unlockJar();
    const known = await call(resetRoute, jsonRequest('POST', '/api/v1/auth/password-reset', { email: 'alice@example.com' }, target));
    const unknown = await call(resetRoute, jsonRequest('POST', '/api/v1/auth/password-reset', { email: 'ghost@example.com' }, target));
    expect(known.status).toBe(200);
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
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

  it('rejects a malformed registration payload before touching the database', async () => {
    const target = await unlockJar();
    const invalid = await call(
      registerRoute,
      jsonRequest(
        'POST',
        '/api/v1/auth/register',
        { name: 'A', email: 'not-an-email', password: 'short', confirmPassword: 'short' },
        target,
      ),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.code).toBe('VALIDATION_ERROR');
  });
});

/**
 * Signup contract, end to end, against the *production* persistence semantics.
 *
 * The reported bug: the UI says "cannot create account" while the account is
 * in fact created and the browser is signed in after a refresh.
 *
 * Root cause (see docs/architecture.md → "Signup flow"):
 *   1. `stores/auth-store.ts#register` posted `/api/v1/auth/register` **twice**
 *      (once through `lib/client/auth-client.ts`, once through
 *      `lib/api-client`).
 *   2. The second POST hits the "email already exists" branch of
 *      `lib/services/auth-service.ts#register`, which read the Argon2 hash off
 *      the `UserRecord` returned by `users.getByEmail()`. The Prisma provider
 *      never puts the hash on that record (`mapUser()` omits it), so the lookup
 *      fell back to `'$invalid$'`, verification failed and the route returned
 *      401 — after the first request had already created the user and set the
 *      `mt_session` cookie.
 *
 * These tests pin both halves of the fix: the endpoint must stay idempotent for
 * a repeated submit, and the client must only submit once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionUser } from '@mt/api-client';
import { GET as meRoute } from '@/app/api/v1/auth/me/route';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { GET as conversationsRoute } from '@/app/api/v1/conversations/route';
import {
  absorb,
  call,
  jar,
  jsonRequest,
  queryRequest,
  resetState,
  unlockJar,
  type Jar,
} from '../helpers/api';
import { installPrismaLikeUsers } from '../helpers/prisma-like-provider';

beforeEach(async () => {
  resetState();
  // Production semantics: the hash is a column, not a field on the record.
  await installPrismaLikeUsers();
});

interface AuthBody {
  user: SessionUser | null;
  accessGranted?: boolean;
  cookieSession?: boolean;
}
type AuthEnvelope = { ok: boolean; data?: AuthBody; error?: { code: string; message: string } };

async function register(body: Record<string, unknown>, target: Jar) {
  const response = await registerRoute(jsonRequest('POST', '/api/v1/auth/register', body, target));
  return { response, body: (await response.json()) as AuthEnvelope };
}

describe('signup against PostgreSQL semantics', () => {
  it('creates the account and signs the browser in on the first request', async () => {
    const target = await unlockJar();
    const { response, body } = await register(
      { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' },
      target,
    );
    absorb(response, target);

    expect(response.status).toBe(201);
    expect(body.data?.user?.email).toBe('alice@example.com');
    expect(target.cookies['mt_session']).toBeTruthy();

    // Immediately authenticated — no refresh required.
    const me = await call<AuthBody>(meRoute, queryRequest('GET', '/api/v1/auth/me', undefined, target));
    expect(me.status).toBe(200);
    expect(me.body.data?.user?.email).toBe('alice@example.com');
  });

  it('does NOT report failure when the same signup is submitted twice (the reported bug)', async () => {
    const target = await unlockJar();
    const payload = { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' };

    const first = await register(payload, target);
    absorb(first.response, target);
    expect(first.response.status).toBe(201);
    const createdId = first.body.data?.user?.id;

    // This is the second POST the old auth store fired, still holding the
    // session cookie from the first one.
    const second = await register(payload, target);
    absorb(second.response, target);

    expect(second.response.status, `second submit returned ${second.response.status}: ${second.body.error?.message}`).toBeLessThan(400);
    expect(second.body.data?.user?.id).toBe(createdId);
    expect(target.cookies['mt_session']).toBeTruthy();
  });

  it('still rejects a duplicate email submitted with the wrong password', async () => {
    const target = await unlockJar();
    await register({ name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' }, target);

    const attacker = await unlockJar();
    const duplicate = await register(
      { name: 'Mallory', email: 'alice@example.com', password: 'WrongPassword1!' },
      attacker,
    );
    expect(duplicate.response.status).toBe(401);
    expect(attacker.cookies['mt_session']).toBeUndefined();
  });

  it('creates exactly one account when the browser retries the request', async () => {
    const target = await unlockJar();
    const payload = { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' };
    const [a, b, c] = await Promise.all([
      register(payload, jar()),
      register(payload, jar()),
      register(payload, target),
    ]);
    const ids = new Set(
      [a, b, c].map((r) => r.body.data?.user?.id).filter((id): id is string => Boolean(id)),
    );
    expect(ids.size).toBe(1);
  });

  it('a session created by signup can reach a protected route before any refresh', async () => {
    const target = await unlockJar();
    const { response } = await register(
      { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' },
      target,
    );
    absorb(response, target);
    const conversations = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, target));
    expect(conversations.status).toBe(200);
  });

  it('a failed signup leaves no session behind', async () => {
    const target = await unlockJar();
    const invalid = await register({ name: 'Alice', email: 'nope', password: 'x' }, target);
    expect(invalid.response.status).toBe(422);
    expect(target.cookies['mt_session']).toBeUndefined();
  });

  it('login after signup works against the stored hash column', async () => {
    const target = await unlockJar();
    const { response } = await register(
      { name: 'Alice', email: 'alice@example.com', password: 'CorrectHorse1!' },
      target,
    );
    absorb(response, target);
    expect(response.status).toBe(201);

    const fresh = await unlockJar();
    const login = await loginRoute(
      jsonRequest('POST', '/api/v1/auth/login', { email: 'alice@example.com', password: 'CorrectHorse1!' }, fresh),
    );
    expect(login.status).toBe(200);
  });
});

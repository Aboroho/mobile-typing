/**
 * @vitest-environment jsdom
 *
 * Full access flow and authentication integration test:
 * Typing game secret-code challenge → unlock → register/login → bound access session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePublicEnv, hasFirebaseClientConfig } from '@mt/config';
import { resetAuthClient } from '@/lib/client/auth-client';
import { useAccessStore } from '@/stores/access-store';
import { useAuthStore } from '@/stores/auth-store';
import { resetFirebaseClientAuth } from '../helpers/firebase-client';

vi.mock('firebase/app', async () => (await import('../helpers/firebase-client')).firebaseAppModule);
vi.mock(
  'firebase/auth',
  async () => (await import('../helpers/firebase-client')).firebaseAuthModule,
);

interface RecordedRequest {
  path: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function installApiStub() {
  const requests: RecordedRequest[] = [];
  let currentAccessUnlocked = false;
  let currentAccessUserId: string | null = null;
  const profiles = new Map<string, { id: string; name: string; email: string }>();

  const respond = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: url.pathname, method: init?.method ?? 'GET', authorization, body });

      const uid = authorization?.startsWith('Bearer id-token-')
        ? authorization.slice('Bearer id-token-'.length)
        : null;

      if (url.pathname === '/api/v1/access/challenge') {
        return respond(200, {
          ok: true,
          data: {
            challenge: {
              epoch: 1,
              maxLength: 15,
              caseSensitive: true,
              code: 'opensesame',
              digestAlgorithm: 'sha-256',
              challengeToken: 'test-challenge-token',
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              sessionTtlMs: 600000,
            },
          },
        });
      }

      if (url.pathname === '/api/v1/access/unlock') {
        currentAccessUnlocked = true;
        currentAccessUserId = uid;
        return respond(200, {
          ok: true,
          data: {
            unlocked: true,
            epoch: 1,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            user: uid && profiles.has(uid) ? profiles.get(uid) : null,
          },
        });
      }

      if (url.pathname === '/api/v1/access/status') {
        return respond(200, {
          ok: true,
          data: {
            status: { epoch: 1, maxLength: 15, caseSensitive: true, configured: true },
            unlocked: currentAccessUnlocked,
            session: currentAccessUnlocked
              ? {
                  epoch: 1,
                  expiresAt: new Date(Date.now() + 600000).toISOString(),
                  userId: currentAccessUserId,
                }
              : null,
          },
        });
      }

      if (url.pathname === '/api/v1/access/lock') {
        currentAccessUnlocked = false;
        currentAccessUserId = null;
        return respond(200, { ok: true, data: { locked: true } });
      }

      if (url.pathname === '/api/v1/auth/register') {
        if (!uid) {
          return respond(401, {
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'sign up first' },
          });
        }
        const user = {
          id: uid,
          name: String(body['name'] ?? 'User'),
          email: String(body['email'] ?? `${uid}@example.com`),
          photoUrl: null,
          status: 'active' as const,
          isAdmin: false,
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
        };
        profiles.set(uid, user);
        currentAccessUserId = uid;
        return respond(201, {
          ok: true,
          data: { user, token: null, cookieSession: true, accessGranted: currentAccessUnlocked },
        });
      }

      if (url.pathname === '/api/v1/auth/login') {
        if (!uid) {
          return respond(401, {
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'login first' },
          });
        }
        const user = profiles.get(uid) ?? {
          id: uid,
          name: 'Alice',
          email: `${uid}@example.com`,
          photoUrl: null,
          status: 'active' as const,
          isAdmin: false,
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
        };
        currentAccessUserId = uid;
        return respond(200, {
          ok: true,
          data: { user, token: null, cookieSession: true, accessGranted: currentAccessUnlocked },
        });
      }

      if (url.pathname === '/api/v1/auth/reauthenticate') {
        currentAccessUserId = uid;
        return respond(200, {
          ok: true,
          data: {
            user: uid ? (profiles.get(uid) ?? null) : null,
            accessGranted: true,
          },
        });
      }

      if (url.pathname === '/api/v1/auth/me') {
        const user = uid ? (profiles.get(uid) ?? null) : null;
        return respond(200, { ok: true, data: { user } });
      }

      if (url.pathname === '/api/v1/auth/logout') {
        return respond(200, { ok: true, data: { loggedOut: true } });
      }

      return respond(404, { ok: false, error: { code: 'NOT_FOUND' } });
    }),
  );

  return {
    requests,
    profiles,
    setAccessUserId(id: string | null) {
      currentAccessUserId = id;
    },
    setAccessUnlocked(unlocked: boolean) {
      currentAccessUnlocked = unlocked;
    },
  };
}

describe('secret-code challenge to signup/login flow', () => {
  beforeEach(() => {
    resetFirebaseClientAuth();
    resetAuthClient();
    installApiStub();
    useAccessStore.setState({
      challenge: null,
      status: null,
      unlocked: false,
      boundUserId: null,
      epoch: null,
      expiresAt: null,
      loading: false,
      error: null,
    });
    useAuthStore.setState({ user: null, initializing: true, error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAuthClient();
  });

  it('correctly provides client Firebase configuration without throwing', () => {
    const config = parsePublicEnv();
    expect(hasFirebaseClientConfig(config)).toBe(true);
    expect(config.NEXT_PUBLIC_FIREBASE_API_KEY).toBeTruthy();
    expect(config.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN).toBeTruthy();
    expect(config.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBeTruthy();
    expect(config.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID).toBeTruthy();
    expect(config.NEXT_PUBLIC_FIREBASE_APP_ID).toBeTruthy();
  });

  it('completes the full flow: start challenge → unlock with code → register → access granted with boundUserId', async () => {
    // 1. Initial state: locked
    expect(useAccessStore.getState().unlocked).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();

    // 2. Fetch challenge
    const challenge = await useAccessStore.getState().startChallenge();
    expect(challenge).not.toBeNull();
    expect(challenge?.code).toBe('opensesame');

    // 3. Unlock with the secret code
    const unlocked = await useAccessStore.getState().unlockWithCode('opensesame');
    expect(unlocked).toBe(true);
    expect(useAccessStore.getState().unlocked).toBe(true);
    // User is not signed in yet, so boundUserId is null initially
    expect(useAccessStore.getState().boundUserId).toBeNull();

    // 4. Register new user
    const regResult = await useAuthStore.getState().register({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'SecurePassword123!',
      confirmPassword: 'SecurePassword123!',
    });

    expect(regResult.ok).toBe(true);
    expect(regResult.accessGranted).toBe(true);

    const user = useAuthStore.getState().user;
    expect(user).not.toBeNull();
    expect(user?.name).toBe('Bob');
    expect(user?.email).toBe('bob@example.com');

    // 5. boundUserId MUST match the newly registered user id so reauth is NOT prompted
    expect(useAccessStore.getState().boundUserId).toBe(user?.id);
    expect(useAccessStore.getState().unlocked).toBe(true);
  });

  it('completes the full flow: start challenge → unlock with code → login → access granted with boundUserId', async () => {
    // Register first so user exists
    await useAccessStore.getState().startChallenge();
    await useAccessStore.getState().unlockWithCode('opensesame');
    await useAuthStore.getState().register({
      name: 'Charlie',
      email: 'charlie@example.com',
      password: 'SecurePassword123!',
      confirmPassword: 'SecurePassword123!',
    });
    const charlieId = useAuthStore.getState().user?.id;

    // Logout and lock
    await useAuthStore.getState().logout();
    await useAccessStore.getState().lock({ silent: true });

    expect(useAccessStore.getState().unlocked).toBe(false);
    expect(useAccessStore.getState().boundUserId).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();

    // Unlock again with code
    await useAccessStore.getState().startChallenge();
    await useAccessStore.getState().unlockWithCode('opensesame');
    expect(useAccessStore.getState().unlocked).toBe(true);

    // Login with existing account
    const loginResult = await useAuthStore.getState().login({
      email: 'charlie@example.com',
      password: 'SecurePassword123!',
    });

    expect(loginResult.ok).toBe(true);
    expect(loginResult.accessGranted).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe(charlieId);

    // boundUserId is synchronized to charlieId
    expect(useAccessStore.getState().boundUserId).toBe(charlieId);
  });

  it('restores unlocked and boundUserId on page refresh', async () => {
    const apiStub = installApiStub();
    apiStub.setAccessUnlocked(true);
    apiStub.setAccessUserId('web_davidxamplecom');

    await useAccessStore.getState().refresh();

    expect(useAccessStore.getState().unlocked).toBe(true);
    expect(useAccessStore.getState().boundUserId).toBe('web_davidxamplecom');
    expect(useAccessStore.getState().epoch).toBe(1);
  });
});

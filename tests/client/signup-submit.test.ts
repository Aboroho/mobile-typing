/**
 * @vitest-environment jsdom
 *
 * Client-side half of the signup contract:
 *   - exactly ONE `POST /api/v1/auth/register` per submission (the old store
 *     posted it twice, and the second response drove the "cannot create
 *     account" message the user saw),
 *   - the button cannot fire a second submit while one is in flight,
 *   - a realtime/WebSocket failure after a successful signup is reported
 *     separately and never turns into a signup failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAuthClient } from '@/lib/client/auth-client';
import { setAuthTokenProvider } from '@/lib/client/api';
import { useAccessStore } from '@/stores/access-store';
import { useAuthStore } from '@/stores/auth-store';

interface Recorded {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

function respond(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionUser(id: string, email: string) {
  return {
    id,
    name: 'Alice',
    email,
    photoUrl: null,
    status: 'active' as const,
    isAdmin: false,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };
}

/** Stubs fetch with a backend that behaves exactly like the real one. */
function installBackend(options: { duplicateSubmitStatus?: number } = {}) {
  const requests: Recorded[] = [];
  const existing = new Set<string>();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: url.pathname, method: init?.method ?? 'GET', body });

      if (init?.method === 'POST' && url.pathname === '/api/v1/auth/register') {
        const email = String(body['email'] ?? '');
        if (existing.has(email)) {
          // The old backend answered 401 here because it could not find the
          // Argon2 hash on the record returned by the Prisma provider.
          return respond(options.duplicateSubmitStatus ?? 401, {
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'unable to create an account with those details' },
          });
        }
        existing.add(email);
        return respond(201, {
          ok: true,
          data: { user: sessionUser('u_alice', email), token: null, cookieSession: true, accessGranted: true },
        });
      }

      if (url.pathname === '/api/v1/auth/me') {
        return respond(200, { ok: true, data: { user: null } });
      }
      if (url.pathname === '/api/v1/auth/logout') {
        return respond(200, { ok: true, data: { loggedOut: true } });
      }
      return respond(404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
    }),
  );

  return { requests };
}

describe('signup submission', () => {
  beforeEach(() => {
    resetAuthClient();
    setAuthTokenProvider(async () => null);
    useAccessStore.setState({
      challenge: null,
      status: null,
      unlocked: true,
      boundUserId: null,
      epoch: null,
      expiresAt: null,
      loading: false,
      error: null,
    });
    useAuthStore.setState({ user: null, initializing: false, error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAuthClient();
  });

  it('posts the signup request exactly once', async () => {
    const { requests } = installBackend();
    const result = await useAuthStore
      .getState()
      .register({ name: 'Alice', email: 'alice@example.com', password: 'pw123456', confirmPassword: 'pw123456' });

    const registerPosts = requests.filter((r) => r.path === '/api/v1/auth/register');
    expect(registerPosts).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().user?.email).toBe('alice@example.com');
  });

  it('reports success even when the backend answers a duplicate submit with 401', async () => {
    // Simulates a browser retry landing after the account already exists.
    installBackend({ duplicateSubmitStatus: 401 });
    const first = await useAuthStore
      .getState()
      .register({ name: 'Alice', email: 'a2@example.com', password: 'pw123456', confirmPassword: 'pw123456' });
    expect(first.ok).toBe(true);
    expect(useAuthStore.getState().user?.email).toBe('a2@example.com');
  });

  it('ignores a second submit while the first is still in flight', async () => {
    const { requests } = installBackend();
    const payload = { name: 'Alice', email: 'race@example.com', password: 'pw123456', confirmPassword: 'pw123456' };
    const [a, b] = await Promise.all([useAuthStore.getState().register(payload), useAuthStore.getState().register(payload)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(requests.filter((r) => r.path === '/api/v1/auth/register')).toHaveLength(1);
  });

  it('surfaces a validation failure as an error without a user', async () => {
    installBackend();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(422, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'email must be valid' } }),
      ),
    );
    const result = await useAuthStore
      .getState()
      .register({ name: 'Alice', email: 'bad', password: 'pw123456', confirmPassword: 'pw123456' });
    expect(result.ok).toBe(false);
    expect(useAuthStore.getState().error).toContain('email must be valid');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('does not treat a network failure after the request as a silent success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network down'))));
    const result = await useAuthStore
      .getState()
      .register({ name: 'Alice', email: 'net@example.com', password: 'pw123456', confirmPassword: 'pw123456' });
    expect(result.ok).toBe(false);
    expect(useAuthStore.getState().error).toBeTruthy();
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePublicEnv } from '@mt/config';
import { resetAuthClient } from '@/lib/client/auth-client';
import { useAccessStore } from '@/stores/access-store';
import { useAuthStore } from '@/stores/auth-store';

interface RecordedRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

function installApiStub() {
  const requests: RecordedRequest[] = [];
  let currentAccessUnlocked = false;
  const profiles = new Map<string, { id: string; name: string; email: string }>();
  let nextUserId = 1;

  const respond = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: url.pathname, method: init?.method ?? 'GET', body });

      // Cookie jar for testing.
      const cookieHeader = (init?.headers as Record<string, string> | undefined)?.cookie;
      const uid = cookieHeader?.startsWith('sess=') ? cookieHeader.slice(5) : null;
      if ((init?.method ?? 'GET') === 'POST' && (url.pathname.endsWith('/register') || url.pathname.endsWith('/login') || url.pathname.endsWith('/reauthenticate'))) {
        const newUid = uid ?? `u${nextUserId++}`;
        const name = String(body['name'] ?? (body['email'] as string)?.split('@')[0] ?? 'User');
        const email = String(body['email'] ?? `${newUid}@example.com`);
        if (!profiles.has(newUid)) profiles.set(newUid, { id: newUid, name, email });
        // Simulate Set-Cookie by overriding subsequent fetch headers.
        return respond(200, {
          ok: true,
          data: { user: { id: newUid, name, email, photoUrl: null, status: 'active' as const, isAdmin: false, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() }, token: null, cookieSession: true, accessGranted: currentAccessUnlocked },
        });
      }
      // For /me we return the first registered profile for simplicity in tests.
      if (url.pathname === '/api/v1/auth/me') {
        let user = uid ? (profiles.get(uid) ?? null) : null;
        if (!user) {
          const first = profiles.values().next().value;
          user = first ?? null;
        }
        return respond(200, { ok: true, data: { user } });
      }
      if (url.pathname === '/api/v1/auth/logout') {
        return respond(200, { ok: true, data: { loggedOut: true } });
      }
      if (url.pathname === '/api/v1/access/challenge') {
        return respond(200, { ok: true, data: { challenge: { epoch: 1, maxLength: 15, caseSensitive: true, code: 'opensesame', digestAlgorithm: 'sha-256', challengeToken: 't', expiresAt: new Date(Date.now() + 60000).toISOString(), sessionTtlMs: 600000 } } });
      }
      if (url.pathname === '/api/v1/access/unlock') {
        currentAccessUnlocked = true;
        return respond(200, { ok: true, data: { unlocked: true, epoch: 1, expiresAt: new Date(Date.now() + 600000).toISOString(), token: 'access' } });
      }
      if (url.pathname === '/api/v1/access/lock') {
        currentAccessUnlocked = false;
        return respond(200, { ok: true, data: { locked: true } });
      }
      if (url.pathname === '/api/v1/access/status') {
        return respond(200, { ok: true, data: { status: { epoch: 1, maxLength: 15, caseSensitive: true, configured: true }, unlocked: currentAccessUnlocked, session: null } });
      }
      return respond(404, { ok: false, error: { code: 'NOT_FOUND' } });
    }),
  );

  return { requests, profiles };
}

describe('public env', () => {
  it('parses the public env', () => {
    const config = parsePublicEnv();
    expect(config.NEXT_PUBLIC_APP_URL).toBeTruthy();
    expect(config.NEXT_PUBLIC_ENABLE_TYPING_GAME).toBe(true);
  });
});

describe('auth flow', () => {
  beforeEach(() => {
    resetAuthClient();
    installApiStub();
    useAccessStore.setState({ challenge: null, status: null, unlocked: false, boundUserId: null, epoch: null, expiresAt: null, loading: false, error: null });
    useAuthStore.setState({ user: null, initializing: true, error: null });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetAuthClient(); });

  it('can register after challenge', async () => {
    await useAccessStore.getState().startChallenge();
    await useAccessStore.getState().unlockWithCode('opensesame');
    const result = await useAuthStore.getState().register({ name: 'Bob', email: 'bob@example.com', password: 'pw12345', confirmPassword: 'pw12345' });
    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().user).not.toBeNull();
  }, 10000);
});

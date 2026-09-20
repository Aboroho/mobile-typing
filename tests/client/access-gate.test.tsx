/**
 * @vitest-environment jsdom
 *
 * Regression tests for the "typed the unlock code, nothing happened" and the
 * wall of `403 GET /api/v1/calls/events` reports.
 *
 * Both come from the same place: the client treating the secret-code gate as a
 * UI detail. It armed the keystroke detector with up to six challenge requests
 * per page load — a handful of reloads (two copies of the effect, doubled again
 * by React's development double-invoke) exhausted the challenge rate limit, and
 * a rate-limited answer left the page with no challenge, so no code could ever
 * match. Meanwhile every browser that still held a two-week session cookie
 * subscribed to the call stream before unlocking, and the server answered 403
 * `ACCESS_REQUIRED` for as long as the tab stayed open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { AccessChallenge } from '@mt/types';
import type { SessionUser } from '@mt/api-client';
import { RootProviders } from '@/components/providers';
import { resetAuthClient } from '@/lib/client/auth-client';
import { resetAccessSessionProbe } from '@/lib/browser/access-session';
import { resetRealtimeClient } from '@/lib/browser/realtime-client';
import { useAccessStore } from '@/stores/access-store';
import { useAuthStore } from '@/stores/auth-store';
import { resetChatStore } from '@/stores/chat-store';

function challenge(token = 'token-1', epoch = 1): AccessChallenge {
  return {
    epoch,
    maxLength: 15,
    caseSensitive: true,
    code: 'opensesame',
    digestAlgorithm: 'sha-256',
    challengeToken: token,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sessionTtlMs: 1_800_000,
  };
}

const USER: SessionUser = {
  id: 'u_1',
  name: 'Phone Tester',
  email: 'phone@example.com',
  photoUrl: null,
  status: 'active',
  isAdmin: false,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  lastLoginAt: null,
};

function json(status: number, data: unknown, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ok: status < 400, data, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(status: number, body: unknown) {
  return new Response(JSON.stringify({ ok: false, error: body }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {}
}

const callStreams = () =>
  FakeEventSource.instances.filter((source) => source.url.includes('/api/v1/calls/events'));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/access/status')) {
      return json(200, {
        status: { epoch: 1, maxLength: 15, caseSensitive: true, configured: true },
        unlocked: useAccessStore.getState().unlocked,
        session: null,
      });
    }
    if (url.includes('/api/v1/auth/me')) return json(200, { user: useAuthStore.getState().user });
    return json(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  resetAccessSessionProbe();
  resetChatStore();
  resetRealtimeClient();
  resetAuthClient();
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
  useAuthStore.setState({ user: null, initializing: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetRealtimeClient();
});

describe('challenge arming', () => {
  it('sends one request however many callers arm the gate at once', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/v1/access/challenge');
      return json(200, { challenge: challenge() });
    });

    const [a, b, c] = await Promise.all([
      useAccessStore.getState().startChallenge(),
      useAccessStore.getState().startChallenge(),
      useAccessStore.getState().startChallenge(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a?.challengeToken).toBe('token-1');
    expect(b?.challengeToken).toBe('token-1');
    expect(c?.challengeToken).toBe('token-1');
  });

  it('retries a rate-limited challenge so the gate re-arms without a reload', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        error(429, {
          code: 'RATE_LIMITED',
          message: 'too many requests, slow down',
          context: { retryAfterSeconds: 3 },
        }),
      )
      .mockResolvedValueOnce(json(200, { challenge: challenge('token-2') }));

    const first = await useAccessStore.getState().startChallenge();
    expect(first).toBeNull();
    expect(useAccessStore.getState().challenge).toBeNull();

    await vi.advanceTimersByTimeAsync(3_100);
    await vi.waitFor(() =>
      expect(useAccessStore.getState().challenge?.challengeToken).toBe('token-2'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a challenge that the slower status response would otherwise clear', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/access/status')) {
        // Lands after the challenge, like the two first-paint requests really do.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json(200, {
          status: { epoch: 1, maxLength: 15, caseSensitive: true, configured: true },
          unlocked: false,
          session: null,
        });
      }
      return json(200, { challenge: challenge() });
    });

    await Promise.all([
      useAccessStore.getState().startChallenge(),
      useAccessStore.getState().refresh(),
    ]);

    expect(useAccessStore.getState().challenge?.challengeToken).toBe('token-1');
  });

  it('re-arms after a failed unlock, because the challenge is single use', async () => {
    let issued = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/access/challenge')) {
        issued += 1;
        return json(200, { challenge: challenge(`token-${issued}`) });
      }
      return error(412, {
        code: 'PRECONDITION_FAILED',
        message: 'that was not the right sequence',
      });
    });

    await useAccessStore.getState().startChallenge();
    const unlocked = await useAccessStore.getState().unlockWithCode('not-the-code');

    expect(unlocked).toBe(false);
    await waitFor(() =>
      expect(useAccessStore.getState().challenge?.challengeToken).toBe('token-2'),
    );
  });
});

describe('access gate subscriptions', () => {
  it('never opens the call stream while the browser is still on the game screen', async () => {
    useAuthStore.setState({ user: USER, initializing: false });
    render(
      <RootProviders>
        <div />
      </RootProviders>,
    );

    // The signed-in-but-locked browser asks for the access status (and may
    // restore the session), but must not touch a user-scoped stream.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(callStreams()).toHaveLength(0);
  });

  it('opens the call stream once the code has been entered', async () => {
    useAuthStore.setState({ user: USER, initializing: false });
    render(
      <RootProviders>
        <div />
      </RootProviders>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    act(() => {
      useAccessStore.setState({ unlocked: true, boundUserId: USER.id });
    });

    await waitFor(() => expect(callStreams()).toHaveLength(1));
  });
});

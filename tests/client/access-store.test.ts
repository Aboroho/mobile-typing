/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccessStore } from '@/stores/access-store';

const challenge = {
  epoch: 1,
  maxLength: 15,
  caseSensitive: true,
  code: 'opensesame',
  digestAlgorithm: 'sha-256',
  challengeToken: 'test-challenge',
  expiresAt: '2030-01-01T00:00:00.000Z',
  sessionTtlMs: 60_000,
};

function response(status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { ok: true, data: { challenge } }
        : { ok: false, error: { code: 'INTERNAL', message: 'try again' } },
    ),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

beforeEach(() => {
  useAccessStore.setState({
    challenge: null,
    unlocked: false,
    boundUserId: null,
    loading: false,
    error: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('access challenge initialization', () => {
  it('coalesces simultaneous effects into one challenge instead of resetting the detector', async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const first = useAccessStore.getState().startChallenge();
    const second = useAccessStore.getState().startChallenge();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release(response());
    expect(await first).toEqual(challenge);
    expect(await second).toEqual(challenge);
    expect(useAccessStore.getState()).toMatchObject({ challenge, loading: false });
  });

  it('allows a retry after the challenge request failed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchImpl);
    expect(await useAccessStore.getState().startChallenge()).toBeNull();
    expect(await useAccessStore.getState().startChallenge()).toEqual(challenge);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(useAccessStore.getState().error).toBeNull();
  });
});

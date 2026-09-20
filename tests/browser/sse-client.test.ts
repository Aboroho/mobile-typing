/**
 * @vitest-environment jsdom
 *
 * The streaming transports cannot see *why* an `EventSource` failed: a rejected
 * stream (403 `ACCESS_REQUIRED`, i.e. the access session expired) is
 * indistinguishable from a dropped connection. These tests pin the escape hatch
 * — `shouldReconnect` — that lets a caller give up on an authorisation failure
 * while still retrying ordinary network problems, plus the probe that answers
 * the question without trusting a stream's silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEventStream } from '@/lib/browser/sse-client';
import { accessSessionGone, resetAccessSessionProbe } from '@/lib/browser/access-session';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(): void {}
  close(): void {
    this.closed = true;
  }

  fail(): void {
    this.onerror?.();
  }
}

/** The nth stream the client opened. */
function nth(index: number): FakeEventSource {
  const source = FakeEventSource.instances[index];
  if (!source) throw new Error(`expected an EventSource at index ${index}`);
  return source;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  resetAccessSessionProbe();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('connectEventStream reconnect policy', () => {
  it('stops reconnecting when the caller reports the session is gone', async () => {
    vi.useFakeTimers();
    const shouldReconnect = vi.fn(async () => false);
    const dispose = connectEventStream({
      url: '/api/v1/calls/events',
      events: {},
      shouldReconnect,
    });

    nth(0).fail();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(FakeEventSource.instances).toHaveLength(2);

    // The second failure is the one that asks; a "no" ends the loop.
    nth(1).fail();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(shouldReconnect).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    dispose();
  });

  it('keeps retrying after a transient failure', async () => {
    vi.useFakeTimers();
    const shouldReconnect = vi.fn(async () => true);
    const dispose = connectEventStream({
      url: '/api/v1/calls/events',
      events: {},
      shouldReconnect,
    });

    nth(0).fail();
    await vi.advanceTimersByTimeAsync(1_100);
    nth(1).fail();
    await vi.advanceTimersByTimeAsync(2_100);

    expect(shouldReconnect).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(3);
    dispose();
  });
});

describe('accessSessionGone', () => {
  it('reports a revoked access session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, data: { unlocked: false, session: null, status: {} } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    await expect(accessSessionGone()).resolves.toBe(true);
  });

  it('reports a live access session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, data: { unlocked: true, session: {} } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    await expect(accessSessionGone()).resolves.toBe(false);
  });

  it('fails open when the probe itself cannot be answered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(accessSessionGone()).resolves.toBe(false);
  });
});

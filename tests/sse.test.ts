import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventStream } from '@/lib/realtime/sse';
import { publish } from '@/lib/realtime/bus';

afterEach(() => vi.useRealTimers());

describe('SSE session cleanup', () => {
  it('stops timers and unsubscribes when logout/navigation cancels a stream', async () => {
    vi.useFakeTimers();
    const filter = vi.fn(() => true);
    const reader = createEventStream({
      topics: ['test:logout'],
      heartbeatMs: 10,
      filter,
    }).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
    publish('test:logout', 'message', { text: 'before logout' });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('before logout');
    expect(filter).toHaveBeenCalledTimes(1);

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    // Previously the next heartbeat enqueued into a closed controller and
    // raised an uncaught exception in the Next.js server after every logout.
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    publish('test:logout', 'message', { text: 'after logout' });
    expect(filter).toHaveBeenCalledTimes(1);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it('still emits heartbeats while the client is connected', async () => {
    vi.useFakeTimers();
    const reader = createEventStream({ topics: [], heartbeatMs: 10 }).getReader();
    await reader.read();
    vi.advanceTimersByTime(10);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': heartbeat');
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up on the maximum stream lifetime too', async () => {
    vi.useFakeTimers();
    const reader = createEventStream({
      topics: ['test:expiry'],
      heartbeatMs: 31 * 60_000,
    }).getReader();
    await reader.read();
    vi.advanceTimersByTime(30 * 60_000);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });
});

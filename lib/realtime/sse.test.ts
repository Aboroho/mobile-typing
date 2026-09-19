import { afterEach, describe, expect, it, vi } from 'vitest';
import { publish } from './bus';
import { createEventStream } from './sse';

const decoder = new TextDecoder();

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const result = await reader.read();
  return result.value ? decoder.decode(result.value) : '';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createEventStream', () => {
  it('delivers events and stops heartbeats safely when the consumer cancels', async () => {
    vi.useFakeTimers();
    const stream = createEventStream({ topics: ['conversation:test'], heartbeatMs: 100 });
    const reader = stream.getReader();

    expect(await readFrame(reader)).toContain('event: ready');

    publish('conversation:test', 'message.created', { text: 'hello' });
    expect(await readFrame(reader)).toContain('data: {"text":"hello"}');

    await reader.cancel();

    // This used to leave the interval alive. Its next enqueue threw
    // ERR_INVALID_STATE because cancellation had closed the controller.
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => publish('conversation:test', 'message.created', { text: 'late' })).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes and releases timers when the request is aborted', async () => {
    vi.useFakeTimers();
    const request = new AbortController();
    const reader = createEventStream({
      topics: ['conversation:abort'],
      heartbeatMs: 100,
      signal: request.signal,
    }).getReader();

    await readFrame(reader);
    request.abort();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });
});

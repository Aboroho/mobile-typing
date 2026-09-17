/**
 * @vitest-environment jsdom
 *
 * Ensures the Start test action never gets stuck when the word list is empty
 * or the fetch fails — the original bug report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTypingGame } from '@/hooks/use-typing-game';

describe('useTypingGame start button', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(['the', 'and', 'you', 'that', 'with'].join('\n'), {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads words and starts the test', async () => {
    const { result } = renderHook(() => useTypingGame());

    await waitFor(() => expect(result.current.words.length).toBeGreaterThan(0));
    expect(result.current.phase).toBe('setup');

    act(() => {
      result.current.start();
    });

    expect(result.current.phase).toBe('running');
    expect(result.current.currentWord.length).toBeGreaterThan(0);
  });

  it('still starts when the word-list fetch fails (built-in fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const { result } = renderHook(() => useTypingGame());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.words.length).toBeGreaterThan(0);
    expect(result.current.wordListError).toMatch(/built-in/i);

    act(() => {
      result.current.start();
    });

    expect(result.current.phase).toBe('running');
  });

  it('starts immediately even before words finish loading (last-resort fallback)', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const { result } = renderHook(() => useTypingGame());
    expect(result.current.loading).toBe(true);
    expect(result.current.words).toEqual([]);

    act(() => {
      result.current.start();
    });

    expect(result.current.phase).toBe('running');
    expect(result.current.words.length).toBeGreaterThan(0);

    // Unblock the hanging fetch so the effect can settle.
    act(() => {
      resolveFetch(
        new Response('alpha\nbravo\n', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    });
  });
});

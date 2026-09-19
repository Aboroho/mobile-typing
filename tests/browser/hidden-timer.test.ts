import { describe, expect, it, vi } from 'vitest';
import { createHiddenTimer, type HiddenStampStorage } from '@/lib/browser/hidden-timer';
import type { Scheduler } from '@/lib/browser/typing-indicator';

function fakeScheduler(): Scheduler & { advance(ms: number): void } {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    now: () => now,
    setTimeout: (handler, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, handler });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].handler();
      }
      now = target;
    },
  };
}

function memoryStorage(initial: number | null = null): HiddenStampStorage & { value: number | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (at: number) => {
      store.value = at;
    },
    clear: () => {
      store.value = null;
    },
  };
  return store;
}

const THRESHOLD = 60_000;

describe('createHiddenTimer', () => {
  it('does not fire when the page comes back before the threshold', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    let hidden = false;
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => hidden, scheduler });

    hidden = true;
    timer.hidden();
    scheduler.advance(59_000);
    hidden = false;
    timer.visible();
    scheduler.advance(120_000);

    expect(onExpire).not.toHaveBeenCalled();
    expect(timer.hiddenForMs()).toBeNull();
  });

  it('fires from the timer once the page has been hidden for the threshold', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    const storage = memoryStorage();
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => true, scheduler, storage });

    timer.hidden();
    expect(storage.value).toBe(scheduler.now());
    scheduler.advance(THRESHOLD);

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire.mock.calls[0]![0]).toMatchObject({ trigger: 'timer', hiddenForMs: THRESHOLD });
    expect(storage.value).toBeNull();

    // Coming back later does not fire a second time.
    timer.visible();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('fires on return when the timer never ran (suspended mobile tab)', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    let hidden = false;
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => hidden, scheduler });

    hidden = true;
    timer.hidden();
    // Simulate a suspended runtime: the clock jumps but no timer fires.
    (scheduler as unknown as { now: () => number }).now = (() => {
      const base = scheduler.now();
      return () => base + 5 * 60_000;
    })();
    hidden = false;
    timer.visible();

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire.mock.calls[0]![0].trigger).toBe('resume');
  });

  it('treats repeated hidden signals as one hide', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => true, scheduler });
    timer.hidden();
    scheduler.advance(30_000);
    timer.hidden(); // pagehide after visibilitychange: must not restart the clock
    scheduler.advance(30_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('restores a stamp from a previous page lifetime and locks when it is too old', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    const storage = memoryStorage(scheduler.now() - 2 * THRESHOLD);
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => false, scheduler, storage });

    timer.restore();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire.mock.calls[0]![0].trigger).toBe('restore');
    expect(storage.value).toBeNull();
  });

  it('keeps a fresh stamp from a previous page lifetime when it is recent', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    const storage = memoryStorage(scheduler.now() - 10_000);
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => false, scheduler, storage });
    timer.restore();
    expect(onExpire).not.toHaveBeenCalled();
    expect(storage.value).toBeNull();
  });

  it('continues counting when restored while still hidden', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    const storage = memoryStorage(scheduler.now() - 50_000);
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => true, scheduler, storage });
    timer.restore();
    scheduler.advance(9_000);
    expect(onExpire).not.toHaveBeenCalled();
    scheduler.advance(1_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('stops firing after dispose', () => {
    const scheduler = fakeScheduler();
    const onExpire = vi.fn();
    const timer = createHiddenTimer({ thresholdMs: THRESHOLD, onExpire, isHidden: () => true, scheduler });
    timer.hidden();
    timer.dispose();
    scheduler.advance(10 * THRESHOLD);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

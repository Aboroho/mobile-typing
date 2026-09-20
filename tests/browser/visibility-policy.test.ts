import { describe, expect, it, vi } from 'vitest';
import { createVisibilityPolicy, VISIBILITY_GRACE_MS } from '@/lib/browser/visibility-policy';

/** Drives the policy with a controllable clock instead of real timers. */
function harness(graceMs = VISIBILITY_GRACE_MS) {
  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const onLock = vi.fn();
  const policy = createVisibilityPolicy({
    graceMs,
    onLock,
    now: () => now,
    setTimeoutFn: (handler, ms) => {
      const entry = { at: now + ms, run: handler };
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle) => {
      const index = timers.indexOf(handle as unknown as { at: number; run: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  });

  return {
    policy,
    onLock,
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          timer.run();
        }
      }
    },
  };
}

describe('visibility policy (60 second rule)', () => {
  it('does not lock while the page is visible', () => {
    const { advance, onLock } = harness();
    advance(10 * 60_000);
    expect(onLock).not.toHaveBeenCalled();
  });

  it('locks once the page has been hidden for more than the grace period', () => {
    const { policy, advance, onLock } = harness(60_000);
    policy.onHidden();
    advance(59_999);
    expect(onLock).not.toHaveBeenCalled();
    advance(1);
    expect(onLock).toHaveBeenCalledWith('hidden-timeout');
  });

  it('preserves the chat when the user returns inside the grace period', () => {
    const { policy, advance, onLock } = harness(60_000);
    policy.onHidden();
    expect(policy.isPending()).toBe(true);
    advance(30_000);
    policy.onVisible();
    expect(policy.isPending()).toBe(false);
    advance(10 * 60_000);
    expect(onLock).not.toHaveBeenCalled();
  });

  it('reports how much of the grace period is left', () => {
    const { policy, advance } = harness(60_000);
    policy.onHidden();
    advance(10_000);
    expect(policy.remainingMs()).toBe(50_000);
    policy.onVisible();
    expect(policy.remainingMs()).toBeNull();
  });

  it('a second hidden event does not stack timers', () => {
    const { policy, advance, onLock } = harness(60_000);
    policy.onHidden();
    policy.onHidden();
    policy.onHidden();
    advance(60_000);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('hiding again after a return restarts the full grace period', () => {
    const { policy, advance, onLock } = harness(60_000);
    policy.onHidden();
    advance(50_000);
    policy.onVisible();
    policy.onHidden();
    advance(50_000);
    expect(onLock).not.toHaveBeenCalled();
    advance(10_000);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('does not lock after dispose (unmount)', () => {
    const { policy, advance, onLock } = harness(60_000);
    policy.onHidden();
    policy.dispose();
    advance(120_000);
    expect(onLock).not.toHaveBeenCalled();
  });

  it('uses a 60 second grace period by default', () => {
    expect(VISIBILITY_GRACE_MS).toBe(60_000);
    const { policy, advance, onLock } = harness();
    policy.onHidden();
    advance(59_000);
    expect(onLock).not.toHaveBeenCalled();
    advance(1_000);
    expect(onLock).toHaveBeenCalledTimes(1);
  });
});

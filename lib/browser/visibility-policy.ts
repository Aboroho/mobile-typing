/**
 * The "hidden for more than a minute" rule, as pure logic.
 *
 * Keeping the decision here (rather than inside the React hook) means the
 * timing behaviour can be unit tested with a fake clock, and the hook only has
 * to translate DOM lifecycle events into `onHidden()` / `onVisible()`.
 *
 * Product rules implemented:
 *  - a page that is *hidden* (backgrounded tab, minimised window, app switch on
 *    mobile) starts a grace timer; if it is still hidden when the timer fires,
 *    the chat is locked and the typing game is what the user comes back to;
 *  - returning inside the grace window cancels the pending lock and preserves
 *    the chat exactly as it was;
 *  - losing *focus* alone (switching to another window, clicking the address
 *    bar) never locks anything. Browsers report that as `blur` while
 *    `document.visibilityState` stays `visible`.
 */
export interface VisibilityPolicyOptions {
  /** How long the page may stay hidden before the chat is locked. */
  graceMs?: number;
  onLock: (reason: 'hidden-timeout') => void;
  now?: () => number;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface VisibilityPolicy {
  onHidden(): void;
  onVisible(): void;
  /** True while a lock is pending (page hidden, timer running). */
  isPending(): boolean;
  /** Milliseconds until the pending lock fires, or null when none is pending. */
  remainingMs(): number | null;
  dispose(): void;
}

export const VISIBILITY_GRACE_MS = 60_000;

export function createVisibilityPolicy(options: VisibilityPolicyOptions): VisibilityPolicy {
  const graceMs = options.graceMs ?? VISIBILITY_GRACE_MS;
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt: number | null = null;
  let disposed = false;

  function cancel() {
    if (timer) clearTimeoutFn(timer);
    timer = null;
    hiddenAt = null;
  }

  return {
    onHidden() {
      if (disposed || timer) return;
      hiddenAt = now();
      timer = setTimeoutFn(() => {
        timer = null;
        hiddenAt = null;
        if (disposed) return;
        options.onLock('hidden-timeout');
      }, graceMs);
    },
    onVisible() {
      // Back inside the grace window: cancel and keep the chat as it was.
      cancel();
    },
    isPending() {
      return timer !== null;
    },
    remainingMs() {
      if (timer === null || hiddenAt === null) return null;
      return Math.max(0, graceMs - (now() - hiddenAt));
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

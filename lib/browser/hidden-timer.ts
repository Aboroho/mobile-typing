import { CHAT_HIDDEN_LOCK_MS } from '@mt/types';
import type { Scheduler } from './typing-indicator';

export type HiddenExpiryTrigger = 'timer' | 'resume' | 'restore';

export interface HiddenStampStorage {
  get(): number | null;
  set(at: number): void;
  clear(): void;
}

export interface HiddenTimerOptions {
  /** How long the page may stay hidden before `onExpire` fires. */
  thresholdMs?: number;
  onExpire: (details: { hiddenForMs: number; trigger: HiddenExpiryTrigger }) => void;
  /** `document.visibilityState === 'hidden'` in the browser. */
  isHidden: () => boolean;
  /**
   * Where the "hidden since" stamp survives a frozen tab, a bfcache round trip
   * or a browser-initiated reload. In the browser this is `sessionStorage`,
   * which is per tab — exactly the scope the rule applies to.
   */
  storage?: HiddenStampStorage;
  scheduler?: Scheduler;
}

export interface HiddenTimer {
  /** The page became hidden (visibilitychange, pagehide, freeze). */
  hidden(): void;
  /** The page became visible again (visibilitychange, pageshow, resume, focus). */
  visible(): void;
  /**
   * Re-evaluates a stamp left by an earlier page lifetime. Called once on mount:
   * a tab that was hidden long enough, then discarded and restored, must not
   * come back to an open chat.
   */
  restore(): void;
  /** Milliseconds the page has currently been hidden, or null when visible. */
  hiddenForMs(): number | null;
  dispose(): void;
}

const defaultScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

export const HIDDEN_STAMP_KEY = 'mt:chat-hidden-at';

/** `sessionStorage` backed stamp; silently disabled when storage is unavailable. */
export function sessionStampStorage(key: string = HIDDEN_STAMP_KEY): HiddenStampStorage {
  const read = (): Storage | null => {
    try {
      return typeof window !== 'undefined' ? window.sessionStorage : null;
    } catch {
      return null;
    }
  };
  return {
    get() {
      try {
        const raw = read()?.getItem(key);
        const value = raw ? Number(raw) : Number.NaN;
        return Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    },
    set(at) {
      try {
        read()?.setItem(key, String(at));
      } catch {
        // Private mode or quota: the in-memory stamp still covers the common case.
      }
    },
    clear() {
      try {
        read()?.removeItem(key);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

const memoryStorage = (): HiddenStampStorage => {
  let value: number | null = null;
  return {
    get: () => value,
    set: (at) => {
      value = at;
    },
    clear: () => {
      value = null;
    },
  };
};

/**
 * "Hidden for more than N seconds" detector.
 *
 * Two independent mechanisms decide that the threshold passed, because neither
 * is reliable on its own:
 *
 * 1. A timer armed when the page is hidden. Background tabs throttle timers and
 *    mobile browsers suspend JavaScript entirely, so it may fire late or never.
 * 2. A timestamp taken when the page is hidden and compared on every "visible
 *    again" signal. This is what actually catches a suspended mobile tab: the
 *    comparison happens the moment the user returns.
 *
 * Losing focus is deliberately *not* a hide: `hidden()` is only wired to the
 * Page Visibility / Page Lifecycle events by the caller.
 */
export function createHiddenTimer(options: HiddenTimerOptions): HiddenTimer {
  const thresholdMs = options.thresholdMs ?? CHAT_HIDDEN_LOCK_MS;
  const scheduler = options.scheduler ?? defaultScheduler;
  const storage = options.storage ?? memoryStorage();

  let hiddenAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
  };

  const reset = () => {
    clearTimer();
    hiddenAt = null;
    storage.clear();
  };

  const expire = (since: number, trigger: HiddenExpiryTrigger) => {
    const hiddenForMs = scheduler.now() - since;
    reset();
    options.onExpire({ hiddenForMs, trigger });
  };

  const onTimer = () => {
    timer = null;
    if (disposed || hiddenAt === null) return;
    if (!options.isHidden()) {
      // A missed "visible" event: the user is back, judge by elapsed time.
      evaluate('resume');
      return;
    }
    const since = hiddenAt;
    if (scheduler.now() - since >= thresholdMs) expire(since, 'timer');
    else timer = scheduler.setTimeout(onTimer, thresholdMs - (scheduler.now() - since));
  };

  const evaluate = (trigger: HiddenExpiryTrigger) => {
    const since = hiddenAt ?? storage.get();
    if (since === null) {
      reset();
      return;
    }
    if (scheduler.now() - since >= thresholdMs) expire(since, trigger);
    else reset();
  };

  return {
    hidden() {
      if (disposed || hiddenAt !== null) return;
      hiddenAt = scheduler.now();
      storage.set(hiddenAt);
      clearTimer();
      timer = scheduler.setTimeout(onTimer, thresholdMs);
    },
    visible() {
      if (disposed) return;
      evaluate('resume');
    },
    restore() {
      if (disposed) return;
      if (options.isHidden()) {
        // Restored straight into a hidden state: keep counting from the stamp.
        const since = storage.get();
        if (since !== null && hiddenAt === null) {
          hiddenAt = since;
          const remaining = Math.max(0, thresholdMs - (scheduler.now() - since));
          clearTimer();
          timer = scheduler.setTimeout(onTimer, remaining);
        }
        return;
      }
      evaluate('restore');
    },
    hiddenForMs() {
      return hiddenAt === null ? null : scheduler.now() - hiddenAt;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

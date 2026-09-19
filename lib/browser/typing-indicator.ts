import { TYPING_HEARTBEAT_MS, TYPING_IDLE_MS, TYPING_TTL_MS } from '@mt/types';

type Timer = ReturnType<typeof setTimeout>;

export interface Scheduler {
  now: () => number;
  setTimeout: (handler: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
}

const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

export interface TypingPublisherOptions {
  /** Sends the indicator to the server. Failures are the caller's concern. */
  send: (isTyping: boolean) => void | Promise<void>;
  idleMs?: number;
  heartbeatMs?: number;
  scheduler?: Scheduler;
}

export interface TypingPublisher {
  /**
   * Call on every composer change. `hasContent` is false when the composer was
   * cleared, which stops the indicator immediately.
   */
  noteActivity(hasContent: boolean): void;
  /** Stops immediately: message sent, composer cleared, conversation left, page hidden. */
  stop(): void;
  /** Stops and releases the timer. */
  dispose(): void;
  readonly active: boolean;
}

/**
 * Sender side of the typing indicator.
 *
 * The composer calls `noteActivity` on every keystroke, but the network only
 * sees a "typing" message once per heartbeat window and a single "stopped"
 * message when input pauses for `idleMs` — so rapid typing costs a request every
 * few seconds, not one per character. The heartbeat exists so the receiver's
 * own expiry timer (`createTypingReceiver`) keeps getting refreshed for as long
 * as the user really is typing.
 */
export function createTypingPublisher(options: TypingPublisherOptions): TypingPublisher {
  const idleMs = options.idleMs ?? TYPING_IDLE_MS;
  const heartbeatMs = options.heartbeatMs ?? TYPING_HEARTBEAT_MS;
  const scheduler = options.scheduler ?? realScheduler;

  let active = false;
  let lastSentAt = 0;
  let idleTimer: Timer | null = null;
  let disposed = false;

  const clearIdle = () => {
    if (idleTimer !== null) scheduler.clearTimeout(idleTimer);
    idleTimer = null;
  };

  const emit = (isTyping: boolean) => {
    try {
      const result = options.send(isTyping);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Typing indicators are best effort; a failed ping must not break typing.
    }
  };

  const stop = () => {
    clearIdle();
    if (!active) return;
    active = false;
    lastSentAt = 0;
    emit(false);
  };

  return {
    get active() {
      return active;
    },
    noteActivity(hasContent) {
      if (disposed) return;
      if (!hasContent) {
        stop();
        return;
      }
      const now = scheduler.now();
      if (!active || now - lastSentAt >= heartbeatMs) {
        active = true;
        lastSentAt = now;
        emit(true);
      }
      clearIdle();
      idleTimer = scheduler.setTimeout(stop, idleMs);
    },
    stop,
    dispose() {
      stop();
      disposed = true;
    },
  };
}

export interface TypingReceiverOptions {
  onChange: (isTyping: boolean) => void;
  ttlMs?: number;
  scheduler?: Scheduler;
}

export interface TypingReceiver {
  /** Feed every `typing` event for the conversation. */
  receive(isTyping: boolean): void;
  /** Clear immediately, e.g. when the peer's message arrives. */
  clear(): void;
  dispose(): void;
  readonly isTyping: boolean;
}

/**
 * Receiver side: mirrors the peer's indicator and expires it on its own after
 * `ttlMs` without a refresh, so a sender whose tab was suspended, disconnected
 * or closed mid-word never leaves a stale "typing…" behind.
 */
export function createTypingReceiver(options: TypingReceiverOptions): TypingReceiver {
  const ttlMs = options.ttlMs ?? TYPING_TTL_MS;
  const scheduler = options.scheduler ?? realScheduler;
  let isTyping = false;
  let expiry: Timer | null = null;

  const clearExpiry = () => {
    if (expiry !== null) scheduler.clearTimeout(expiry);
    expiry = null;
  };

  const setTyping = (next: boolean) => {
    if (isTyping === next) return;
    isTyping = next;
    options.onChange(next);
  };

  const clear = () => {
    clearExpiry();
    setTyping(false);
  };

  return {
    get isTyping() {
      return isTyping;
    },
    receive(next) {
      if (!next) {
        clear();
        return;
      }
      clearExpiry();
      expiry = scheduler.setTimeout(clear, ttlMs);
      setTyping(true);
    },
    clear,
    dispose() {
      clearExpiry();
      isTyping = false;
    },
  };
}

export interface SseClientOptions {
  url: string;
  events: Record<string, (payload: unknown) => void>;
  onError?: (error: Event) => void;
  onReady?: () => void;
  /**
   * Asked before a reconnect after a failed attempt. Return `false` to stop:
   * used when the failure is not a network blip but an authorisation problem
   * (the access session expired), where retrying only repeats the 403 forever.
   * Only consulted after the second consecutive failure.
   */
  shouldReconnect?: () => Promise<boolean> | boolean;
}

/** Failures tolerated before {@link SseClientOptions.shouldReconnect} is asked. */
const RECONNECT_PROBE_AFTER = 2;

/**
 * Minimal EventSource wrapper with automatic reconnect + backoff. Used for
 * conversation and call streams; the access-session cookie is sent with the
 * request because EventSource is same-origin and credentialed.
 */
export function connectEventStream(options: SseClientOptions): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retryDelay = 1000;
  let failures = 0;
  let probing = false;

  const scheduleReconnect = () => {
    if (closed) return;
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15_000);
  };

  const connect = () => {
    if (closed) return;
    source = new EventSource(options.url, { withCredentials: true });
    source.onopen = () => {
      retryDelay = 1000;
      failures = 0;
      options.onReady?.();
    };
    source.onerror = (event) => {
      options.onError?.(event);
      source?.close();
      if (closed) return;
      failures += 1;
      const probe = options.shouldReconnect;
      if (!probe || failures < RECONNECT_PROBE_AFTER) {
        scheduleReconnect();
        return;
      }
      // Ask once per failure window; a failed stream must not turn into a probe
      // loop of its own.
      if (probing) return;
      probing = true;
      void Promise.resolve()
        .then(probe)
        .catch(() => true)
        .then((keepGoing) => {
          probing = false;
          if (closed) return;
          if (!keepGoing) {
            // Give up for good: the caller (or a later user action) decides
            // when a new stream should be opened.
            closed = true;
            return;
          }
          scheduleReconnect();
        });
    };
    for (const [name, handler] of Object.entries(options.events)) {
      source.addEventListener(name, (event) => {
        try {
          handler(JSON.parse((event as MessageEvent).data));
        } catch {
          // Malformed frame: ignore rather than dropping the stream.
        }
      });
    }
  };

  connect();
  return () => {
    closed = true;
    source?.close();
  };
}

export interface SseClientOptions {
  url: string;
  events: Record<string, (payload: unknown) => void>;
  onError?: (error: Event) => void;
  onReady?: () => void;
}

/**
 * Minimal EventSource wrapper with automatic reconnect + backoff. Used for
 * conversation and call streams; the access-session cookie is sent with the
 * request because EventSource is same-origin and credentialed.
 */
export function connectEventStream(options: SseClientOptions): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retryDelay = 1000;

  const connect = () => {
    if (closed) return;
    source = new EventSource(options.url, { withCredentials: true });
    source.onopen = () => {
      retryDelay = 1000;
      options.onReady?.();
    };
    source.onerror = (event) => {
      options.onError?.(event);
      source?.close();
      if (closed) return;
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
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

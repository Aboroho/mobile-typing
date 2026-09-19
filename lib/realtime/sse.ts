import type { RealtimeEvent } from './bus';
import { subscribe } from './bus';

export interface SseOptions {
  topics: string[];
  /** Optional filter, e.g. only events addressed to the current user. */
  filter?: (event: RealtimeEvent) => boolean;
  heartbeatMs?: number;
  /** The incoming request signal, used to release subscriptions on disconnect. */
  signal?: AbortSignal;
}

/**
 * Builds a Server-Sent Events stream from the in-process bus. SSE is used
 * instead of websockets because it works on Vercel, survives proxies, and needs
 * no extra infrastructure.
 */
export function createEventStream(options: SseOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  let dispose: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let unsubscribes: Array<() => void> = [];

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        for (const unsubscribe of unsubscribes) unsubscribe();
        unsubscribes = [];
        options.signal?.removeEventListener('abort', close);
      };

      const close = () => {
        if (closed) return;
        cleanup();
        try {
          controller.close();
        } catch {
          // Cancellation may have already closed the controller.
        }
      };

      // Enqueue can throw when the consumer has already closed its side of the
      // stream. Treat that exactly like cancellation and stop all producers.
      const enqueue = (frame: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(frame));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      const send = (event: string, data: unknown) => {
        enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      dispose = cleanup;
      if (options.signal?.aborted) {
        close();
        return;
      }
      options.signal?.addEventListener('abort', close, { once: true });

      send('ready', { at: new Date().toISOString(), topics: options.topics });
      if (closed) return;

      unsubscribes = options.topics.map((topic) =>
        subscribe(topic, (event) => {
          if (options.filter && !options.filter(event)) return;
          send(event.type, event.payload);
        }),
      );

      heartbeat = setInterval(() => {
        enqueue(`: heartbeat ${Date.now()}\n\n`);
      }, heartbeatMs);

      // Bound server-side resources even if a runtime misses disconnect events.
      lifetime = setTimeout(close, 30 * 60 * 1000);
    },
    cancel() {
      // Do not call controller.close() here: cancellation has already closed it.
      dispose?.();
    },
  });
}

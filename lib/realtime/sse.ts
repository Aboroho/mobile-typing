import type { RealtimeEvent } from './bus';
import { subscribe } from './bus';

export interface SseOptions {
  topics: string[];
  /** Optional filter, e.g. only events addressed to the current user. */
  filter?: (event: RealtimeEvent) => boolean;
  heartbeatMs?: number;
}

/**
 * Builds a Server-Sent Events stream from the in-process bus. SSE is used
 * instead of websockets because it works on Vercel, survives proxies, and needs
 * no extra infrastructure.
 */
export function createEventStream(options: SseOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? 25_000;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send('ready', { at: new Date().toISOString(), topics: options.topics });

      const unsubscribes = options.topics.map((topic) =>
        subscribe(topic, (event) => {
          if (options.filter && !options.filter(event)) return;
          send(event.type, event.payload);
        }),
      );

      const heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, heartbeatMs);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        for (const unsubscribe of unsubscribes) unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      // Node aborts the request signal when the browser disconnects.
      const signal = (controller as unknown as { signal?: AbortSignal }).signal;
      signal?.addEventListener('abort', close);
      // Browsers also send a close; give the GC a way in either case.
      setTimeout(close, 30 * 60 * 1000);
    },
    cancel() {
      // Stream closed by the consumer.
    },
  });
}

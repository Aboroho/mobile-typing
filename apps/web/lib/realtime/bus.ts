export interface RealtimeEvent<T = unknown> {
  topic: string;
  type: string;
  payload: T;
  at: string;
}

type Handler = (event: RealtimeEvent) => void;

interface BusState {
  handlers: Map<string, Set<Handler>>;
}

const GLOBAL_KEY = '__mt_realtime_bus_v1';

/**
 * In-process pub/sub used to fan out server side changes to SSE subscribers.
 *
 * With a single serverless instance per request this covers the common case
 * (writer and reader in the same isolate) and is enough for local development.
 * For multi-instance deployments the documented upgrade path is to subscribe to
 * Firestore change feeds directly from the client SDK, which the
 * `RealtimeTransport` abstraction already supports (docs/architecture.md).
 */
function state(): BusState {
  const target = globalThis as unknown as Record<string, BusState | undefined>;
  if (!target[GLOBAL_KEY]) target[GLOBAL_KEY] = { handlers: new Map() };
  return target[GLOBAL_KEY] as BusState;
}

export function publish<T>(topic: string, type: string, payload: T): void {
  const handlers = state().handlers.get(topic);
  if (!handlers || handlers.size === 0) return;
  const event: RealtimeEvent<T> = { topic, type, payload, at: new Date().toISOString() };
  for (const handler of handlers) {
    try {
      handler(event as RealtimeEvent);
    } catch {
      // A broken subscriber must never break the writer.
    }
  }
}

export function subscribe(topic: string, handler: Handler): () => void {
  const handlers = state().handlers.get(topic) ?? new Set<Handler>();
  handlers.add(handler);
  state().handlers.set(topic, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) state().handlers.delete(topic);
  };
}

export const topics = {
  messages: (conversationId: string) => `conversation:${conversationId}:messages`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  typing: (conversationId: string) => `conversation:${conversationId}:typing`,
  userCalls: (userId: string) => `user:${userId}:calls`,
  call: (callId: string) => `call:${callId}`,
  access: (userId: string) => `user:${userId}:access`,
};

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
 * For multi-instance deployments the documented upgrade path is a shared
 * outbox poller (Postgres LISTEN/NOTIFY or Redis Streams) behind the same
 * `publish()` call site (see docs/architecture.md and docs/decisions.md).
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

/**
 * Whether `event` may be forwarded to `userId`.
 *
 * Every payload that carries per-viewer data is tagged with the recipient it
 * was rendered for (`forUserId`) or, for acknowledgements, with the *other*
 * participant it is meant for (`otherUserId`). Both the SSE route and the
 * WebSocket server run events through this single predicate, so a subscriber
 * can never receive a frame rendered for somebody else — even if it is
 * connected to the same topic.
 */
export function eventAddressedTo(event: Pick<RealtimeEvent, 'payload'>, userId: string): boolean {
  const payload = event.payload as { forUserId?: string; otherUserId?: string } | null;
  if (!payload || typeof payload !== 'object') return true;
  if (typeof payload.forUserId === 'string') return payload.forUserId === userId;
  if (typeof payload.otherUserId === 'string') return payload.otherUserId === userId;
  return true;
}

export const topics = {
  messages: (conversationId: string) => `conversation:${conversationId}:messages`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  typing: (conversationId: string) => `conversation:${conversationId}:typing`,
  userCalls: (userId: string) => `user:${userId}:calls`,
  call: (callId: string) => `call:${callId}`,
  access: (userId: string) => `user:${userId}:access`,
};

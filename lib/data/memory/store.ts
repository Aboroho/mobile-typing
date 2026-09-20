import type { Cursor } from '@mt/types';
import { base64UrlDecodeString, base64UrlEncodeString } from '@mt/utils';

/**
 * Cursor encoding for the in-memory provider: `${createdAtMs}|${id}`, base64url
 * encoded. Listings are newest first, which matches every chat UI.
 */
export function encodeCursor(createdAt: string, id: string): string {
  return base64UrlEncodeString(`${new Date(createdAt).getTime()}|${id}`);
}

export interface DecodedCursor {
  createdAtMs: number;
  id: string;
}

export function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  try {
    const [ms, id] = base64UrlDecodeString(cursor).split('|');
    if (!ms || !id) return null;
    return { createdAtMs: Number(ms), id };
  } catch {
    return null;
  }
}

/** Newest-first comparison with a stable tiebreak on id. */
export function compareNewestFirst<T extends { id: string; createdAt: string }>(a: T, b: T): number {
  const delta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Applies a cursor to an already sorted (newest first) array. */
export function afterCursor<T extends { id: string }>(
  items: T[],
  cursor: string | null | undefined,
  keyOf: (item: T) => string = (item) => (item as unknown as { createdAt: string }).createdAt,
): T[] {
  const decoded = decodeCursor(cursor);
  if (!decoded) return items;
  return items.filter((item) => {
    const ms = new Date(keyOf(item)).getTime();
    if (ms < decoded.createdAtMs) return true;
    return ms === decoded.createdAtMs && item.id > decoded.id;
  });
}

export function paginate<T extends { id: string }>(
  items: T[],
  limit: number,
  keyOf: (item: T) => string = (item) => (item as unknown as { createdAt: string }).createdAt,
): Cursor<T> {
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = items.length > page.length;
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor(keyOf(last), last.id) : null,
    hasMore,
  };
}

interface StoreShape {
  users: Map<string, unknown>;
  sessions: Map<string, unknown>;
  conversations: Map<string, unknown>;
  messages: Map<string, unknown>;
  media: Map<string, unknown>;
  calls: Map<string, unknown>;
  auditLogs: unknown[];
  typingSessions: unknown[];
  rateLimits: Map<string, { count: number; resetAt: number }>;
  outbox: unknown[];
  accessConfig: unknown;
  counters: Map<string, number>;
}

const GLOBAL_KEY = '__mt_memory_store_v1';

/**
 * The development/test store lives on `globalThis` so Next.js hot reloads do not
 * wipe the database between requests. It is explicitly *not* durable: restart
 * the process and data is gone (documented in docs/architecture.md).
 */
export function getStore(): StoreShape {
  const target = globalThis as unknown as Record<string, StoreShape | undefined>;
  if (!target[GLOBAL_KEY]) {
    target[GLOBAL_KEY] = {
      users: new Map(),
      sessions: new Map(),
      conversations: new Map(),
      messages: new Map(),
      media: new Map(),
      calls: new Map(),
      auditLogs: [],
      typingSessions: [],
      rateLimits: new Map(),
      outbox: [],
      accessConfig: null,
      counters: new Map(),
    };
  }
  return target[GLOBAL_KEY] as StoreShape;
}

/** Test helper — clears every collection. */
export function resetStore(): void {
  const target = globalThis as unknown as Record<string, StoreShape | undefined>;
  delete target[GLOBAL_KEY];
}

/** ISO-8601 timestamp string, used at every layer including the API. */
export type Timestamp = string;

export interface EntityTimestamps {
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Cursor<T> {
  items: T[];
  /** Opaque cursor for the next page, `null` when the end was reached. */
  nextCursor: string | null;
  hasMore: boolean;
}

export function emptyCursor<T>(): Cursor<T> {
  return { items: [], nextCursor: null, hasMore: false };
}

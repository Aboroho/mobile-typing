import { DELIVERY_RANK, type DeliveryState, type MessageForUser } from '@mt/types';

/**
 * Client-side message synchronisation rules.
 *
 * The conversation view merges three sources that race with each other: the
 * optimistic entry created when the user presses send, the HTTP response of
 * that send, and the realtime stream (which the server publishes *before* the
 * HTTP response is written, so it usually arrives first). Every source is
 * folded into one normalised, ordered list through the functions below, which
 * are pure so that the race can be tested exhaustively without a browser.
 *
 * Identity: a message has one logical identity from the moment it is typed. Own
 * messages carry a client generated `clientMessageId` (also the server's
 * idempotency key), so a canonical message is matched to its optimistic
 * placeholder by that key even though the server assigns a different `id`.
 * Nothing is ever appended when a match exists.
 */

/** Delivery states that only exist in the sender's browser, never on the server. */
export const LOCAL_ONLY_STATES: ReadonlySet<DeliveryState> = new Set<DeliveryState>(['sending', 'failed']);

export function isLocalOnly(message: Pick<MessageForUser, 'deliveryState'>): boolean {
  return LOCAL_ONLY_STATES.has(message.deliveryState);
}

/**
 * Stable React key / identity: the client message id survives the optimistic →
 * canonical transition, whereas `id` changes from the temporary id to the
 * server id. Messages that never had a client id (peer messages from older
 * clients, call records) fall back to the server id.
 */
export function messageKey(message: Pick<MessageForUser, 'id' | 'clientMessageId'>): string {
  return message.clientMessageId ?? message.id;
}

function toMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Deterministic order: creation time, then id so equal timestamps never flip. */
export function compareMessages(a: MessageForUser, b: MessageForUser): number {
  const delta = toMs(a.createdAt) - toMs(b.createdAt);
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortMessages(list: readonly MessageForUser[]): MessageForUser[] {
  return [...list].sort(compareMessages);
}

export function maxDeliveryState(a: DeliveryState, b: DeliveryState): DeliveryState {
  return DELIVERY_RANK[b] > DELIVERY_RANK[a] ? b : a;
}

/**
 * Finds the local counterpart of an incoming message: the same server id, or
 * the same client id (an optimistic placeholder waiting for its canonical
 * version, or a canonical copy that arrived through another path).
 */
export function findMatchIndex(list: readonly MessageForUser[], incoming: MessageForUser): number {
  const byId = list.findIndex((item) => item.id === incoming.id);
  if (byId !== -1) return byId;
  if (!incoming.clientMessageId) return -1;
  return list.findIndex(
    (item) =>
      item.clientMessageId === incoming.clientMessageId &&
      (item.senderId === incoming.senderId || isLocalOnly(item)),
  );
}

/**
 * Combines the local and incoming versions of the same message.
 *
 * - A canonical message always replaces a local placeholder (server is truth).
 * - A local placeholder never overwrites a canonical message (a late failure
 *   after the stream already confirmed the send must not show "failed").
 * - Between two canonical versions the newer `updatedAt` wins, except that the
 *   delivery state only moves forward and deletion is sticky, so a stale event
 *   delivered out of order cannot turn "seen" back into "sent" or resurrect a
 *   deleted message.
 *
 * Returns the *same* object when nothing changed so stores can skip a render.
 */
export function reconcileMessage(current: MessageForUser, incoming: MessageForUser): MessageForUser {
  if (current === incoming) return current;
  if (isLocalOnly(current)) return isLocalOnly(incoming) ? { ...current, ...incoming } : incoming;
  if (isLocalOnly(incoming)) return current;

  const newer = toMs(incoming.updatedAt) >= toMs(current.updatedAt) ? incoming : current;
  const deleted = current.deleted || incoming.deleted;
  const merged: MessageForUser = {
    ...newer,
    deliveryState: maxDeliveryState(current.deliveryState, incoming.deliveryState),
    deleted,
    text: deleted ? null : newer.text,
    deliveredAt: newer.deliveredAt ?? current.deliveredAt ?? incoming.deliveredAt,
    readAt: newer.readAt ?? current.readAt ?? incoming.readAt,
  };
  return shallowEqual(merged, current) ? current : merged;
}

/**
 * Field-wise equality. Nested values (`media`, `replyTo`, `call`, `readBy`) are
 * fresh objects on every parsed event, so they are compared structurally;
 * messages are small enough for that to be cheap.
 */
function shallowEqual(a: MessageForUser, b: MessageForUser): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof MessageForUser>;
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    if (typeof left === 'object' && typeof right === 'object' && left !== null && right !== null) {
      if (JSON.stringify(left) === JSON.stringify(right)) continue;
    }
    return false;
  }
  return true;
}

/** Removes entries that share a server id, keeping the most advanced one. */
export function dedupeMessages(list: readonly MessageForUser[]): MessageForUser[] {
  const byId = new Map<string, MessageForUser>();
  let changed = false;
  for (const item of list) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    changed = true;
    byId.set(item.id, reconcileMessage(existing, item));
  }
  return changed ? Array.from(byId.values()) : [...list];
}

/**
 * Merges one message (from the stream, a send response or a page) into the
 * list. Returns the original array when nothing changed.
 */
export function mergeMessage(list: readonly MessageForUser[], incoming: MessageForUser): MessageForUser[] {
  const index = findMatchIndex(list, incoming);
  if (index === -1) return sortMessages([...list, incoming]);

  const current = list[index]!;
  const merged = reconcileMessage(current, incoming);
  if (merged === current) return list as MessageForUser[];

  const next = [...list];
  next[index] = merged;
  // The id may have changed (placeholder → canonical) — a copy of the canonical
  // message that arrived through another path is folded in, never kept twice.
  return sortMessages(dedupeMessages(next));
}

/** Merges a batch (a page, a reconnect catch-up, or several stream events). */
export function mergeMessages(list: readonly MessageForUser[], incoming: readonly MessageForUser[]): MessageForUser[] {
  let next = list as MessageForUser[];
  for (const message of incoming) next = mergeMessage(next, message);
  return next;
}

/**
 * Inserts (or, on a retry, re-arms) an optimistic placeholder. A placeholder for
 * the same client id is replaced in place so a retry never creates a second row.
 */
export function applyOptimistic(list: readonly MessageForUser[], optimistic: MessageForUser): MessageForUser[] {
  const index = list.findIndex((item) => messageKey(item) === messageKey(optimistic));
  if (index === -1) return sortMessages([...list, optimistic]);
  const current = list[index]!;
  // Never downgrade a message the server already confirmed.
  if (!isLocalOnly(current)) return list as MessageForUser[];
  const next = [...list];
  next[index] = { ...current, ...optimistic, deliveryState: 'sending' };
  return sortMessages(next);
}

/**
 * Marks a send as failed. Only a placeholder still in `sending` can fail: if the
 * stream already delivered the canonical message (the request timed out after
 * the server persisted it), the failure is ignored.
 */
export function markSendFailed(list: readonly MessageForUser[], clientMessageId: string): MessageForUser[] {
  let changed = false;
  const next = list.map((item) => {
    if (item.clientMessageId !== clientMessageId || item.deliveryState !== 'sending') return item;
    changed = true;
    return { ...item, deliveryState: 'failed' as const };
  });
  return changed ? next : (list as MessageForUser[]);
}

/** Applies a delivery/read receipt to the given ids; the state only moves forward. */
export function applyDeliveryState(
  list: readonly MessageForUser[],
  messageIds: readonly string[],
  state: DeliveryState,
  at: string | null = null,
): MessageForUser[] {
  if (messageIds.length === 0) return list as MessageForUser[];
  const targets = new Set(messageIds);
  let changed = false;
  const next = list.map((item) => {
    if (!targets.has(item.id) || isLocalOnly(item)) return item;
    const nextState = maxDeliveryState(item.deliveryState, state);
    if (nextState === item.deliveryState) return item;
    changed = true;
    return {
      ...item,
      deliveryState: nextState,
      deliveredAt: item.deliveredAt ?? at,
      readAt: nextState === 'read' ? (item.readAt ?? at) : item.readAt,
    };
  });
  return changed ? next : (list as MessageForUser[]);
}

/**
 * Applies a "read up to" watermark: every message from `senderId` created at or
 * before `lastReadMessageAt` becomes read. Used when the peer reports that the
 * conversation was read up to a point rather than listing message ids.
 */
export function applyReadWatermark(
  list: readonly MessageForUser[],
  senderId: string,
  lastReadMessageAt: string,
  at: string | null = null,
): MessageForUser[] {
  const watermark = toMs(lastReadMessageAt);
  const ids = list
    .filter(
      (item) =>
        item.senderId === senderId &&
        !isLocalOnly(item) &&
        item.deliveryState !== 'read' &&
        toMs(item.createdAt) <= watermark,
    )
    .map((item) => item.id);
  return applyDeliveryState(list, ids, 'read', at);
}

export function markDeleted(list: readonly MessageForUser[], messageId: string): MessageForUser[] {
  let changed = false;
  const next = list.map((item) => {
    if (item.id !== messageId || item.deleted) return item;
    changed = true;
    return { ...item, deleted: true, text: null, media: null };
  });
  return changed ? next : (list as MessageForUser[]);
}

export function removeByKey(list: readonly MessageForUser[], key: string): MessageForUser[] {
  const next = list.filter((item) => messageKey(item) !== key);
  return next.length === list.length ? (list as MessageForUser[]) : next;
}

/** Newest message the server knows about — the anchor for a reconnect catch-up. */
export function newestCanonical(list: readonly MessageForUser[]): MessageForUser | null {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index]!;
    if (!isLocalOnly(item)) return item;
  }
  return null;
}

/** Oldest message the server knows about — the `before` cursor for pagination. */
export function oldestCanonical(list: readonly MessageForUser[]): MessageForUser | null {
  for (const item of list) {
    if (!isLocalOnly(item)) return item;
  }
  return null;
}

/**
 * Creation time for a new optimistic message. Using the later of "now" and
 * "just after the newest message" keeps a freshly sent message at the bottom of
 * the thread even when the device clock trails the server clock; the canonical
 * server timestamp replaces it on reconciliation.
 */
export function optimisticCreatedAt(list: readonly MessageForUser[], nowMs: number = Date.now()): string {
  const last = list[list.length - 1];
  const floor = last ? toMs(last.createdAt) + 1 : 0;
  return new Date(Math.max(nowMs, floor)).toISOString();
}

/**
 * Ids of messages from the peer that the recipient's device has synchronised
 * but not yet acknowledged as delivered.
 */
export function pendingDeliveryIds(list: readonly MessageForUser[], viewerId: string): string[] {
  return list
    .filter((item) => item.senderId !== viewerId && !isLocalOnly(item) && item.deliveryState === 'sent')
    .map((item) => item.id);
}

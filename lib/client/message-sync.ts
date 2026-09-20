import { DELIVERY_RANK, type DeliveryState, type MessageForUser } from '@mt/types';
import { nextDeliveryState } from '@mt/domain';

/**
 * Client-side message normalisation.
 *
 * A single logical message can reach the store through four independent paths:
 * the optimistic insert, the REST response, a realtime event (WebSocket or
 * SSE) and a paginated fetch. Every path is merged through this module, which
 * is deliberately free of React/Zustand so it can be unit tested.
 *
 * Identity rules:
 *  - the canonical identity is the server message id;
 *  - while a message is still optimistic its `id` *is* its `clientMessageId`,
 *    so two messages are "the same" when either their ids or their
 *    `clientMessageId`s match. That is what stops the duplicate bubble that
 *    appears when the realtime event wins the race against the REST response;
 *  - delivery state only ever moves forward (sending → sent → delivered →
 *    read), so a late event cannot roll a receipt back.
 */

/**
 * Shared with the server (`@mt/types` → `DELIVERY_RANK`) so a client and the
 * API agree on what "further along" means. `failed` ranks with `sending` so a
 * retry can move forward again.
 */
export function deliveryRank(state: DeliveryState | undefined | null): number {
  return state ? (DELIVERY_RANK[state] ?? 0) : 0;
}

export function isOptimistic(message: MessageForUser): boolean {
  return (
    message.deliveryState === 'sending' ||
    message.deliveryState === 'failed' ||
    Boolean(message.clientMessageId && message.id === message.clientMessageId)
  );
}

/** True when two entries describe the same logical message. */
export function sameMessage(a: MessageForUser, b: MessageForUser): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const aClient = a.clientMessageId;
  const bClient = b.clientMessageId;
  if (!aClient || !bClient) return false;
  if (aClient !== bClient) return false;
  // Same client id from the same sender in the same conversation.
  return a.conversationId === b.conversationId;
}

export function sortByTime(list: MessageForUser[]): MessageForUser[] {
  return [...list].sort((a, b) => {
    const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (delta !== 0) return delta;
    // Stable tiebreak so pagination and live inserts agree on ordering.
    return a.id.localeCompare(b.id);
  });
}

/** Drops duplicate entries, keeping the most advanced copy of each message. */
export function dedupeMessages(list: MessageForUser[]): MessageForUser[] {
  const out: MessageForUser[] = [];
  for (const message of list) {
    const index = out.findIndex((other) => sameMessage(other, message));
    if (index === -1) {
      out.push(message);
      continue;
    }
    const previous = out[index];
    if (previous) out[index] = pickCanonical(previous, message);
  }
  return out;
}

/**
 * Chooses between two copies of the same message. The canonical (server id)
 * copy wins over an optimistic one; between two canonical copies the one with
 * the newer `updatedAt` and the further-advanced delivery state wins.
 */
export function pickCanonical(a: MessageForUser, b: MessageForUser): MessageForUser {
  const aOptimistic = isOptimistic(a);
  const bOptimistic = isOptimistic(b);
  if (aOptimistic && !bOptimistic) return mergeDelivery(a, b);
  if (bOptimistic && !aOptimistic) return mergeDelivery(b, a);

  const base = new Date(b.updatedAt ?? b.createdAt).getTime() >= new Date(a.updatedAt ?? a.createdAt).getTime() ? b : a;
  const other = base === b ? a : b;
  return mergeDelivery(other, base);
}

/** Keeps the furthest-advanced delivery/read fields of two copies. */
function mergeDelivery(older: MessageForUser, newer: MessageForUser): MessageForUser {
  const deliveryState =
    deliveryRank(newer.deliveryState) >= deliveryRank(older.deliveryState) ? newer.deliveryState : older.deliveryState;
  const readBy = newer.readBy?.length ? newer.readBy : older.readBy;
  return {
    ...newer,
    // Never lose the client id: retries and the "failed" bubble need it.
    clientMessageId: newer.clientMessageId ?? older.clientMessageId,
    deliveryState,
    deliveredAt: newer.deliveredAt ?? older.deliveredAt ?? null,
    readBy: readBy ?? [],
    readAt: newer.readAt ?? older.readAt ?? null,
  };
}

/**
 * Inserts or replaces `incoming` in `list`, resolving any optimistic copy of
 * the same logical message. Returns a new array sorted by time and free of
 * duplicates.
 */
export function upsertMessage(list: MessageForUser[], incoming: MessageForUser): MessageForUser[] {
  const next: MessageForUser[] = [];
  let placed = false;
  for (const existing of list) {
    if (sameMessage(existing, incoming)) {
      if (!placed) {
        next.push(pickCanonical(existing, incoming));
        placed = true;
      }
      // Any further match is a duplicate of the same message: drop it.
      continue;
    }
    next.push(existing);
  }
  if (!placed) next.push(incoming);
  return sortByTime(next);
}

/** Merges a page of messages (pagination / initial load) into the live list. */
export function mergePage(list: MessageForUser[], page: MessageForUser[]): MessageForUser[] {
  let next = list;
  for (const message of page) next = upsertMessage(next, message);
  return next;
}

/** Applies a `delivered`/`read` acknowledgement to the matching messages. */
export function applyDelivery(
  list: MessageForUser[],
  messageIds: string[],
  state: Extract<DeliveryState, 'delivered' | 'read'>,
): MessageForUser[] {
  if (messageIds.length === 0) return list;
  const ids = new Set(messageIds);
  let changed = false;
  const next = list.map((message) => {
    if (!ids.has(message.id)) return message;
    const nextState = nextDeliveryState(message.deliveryState, state);
    if (nextState === message.deliveryState) return message;
    changed = true;
    return { ...message, deliveryState: nextState };
  });
  return changed ? next : list;
}

/** Marks every pending optimistic message of a conversation as failed. */
export function markAllFailed(list: MessageForUser[]): MessageForUser[] {
  let changed = false;
  const next = list.map((message) => {
    if (message.deliveryState !== 'sending') return message;
    changed = true;
    return { ...message, deliveryState: 'failed' as DeliveryState };
  });
  return changed ? next : list;
}

/** Marks one optimistic message as failed (keeps it on screen for retry). */
export function markFailed(list: MessageForUser[], clientMessageId: string): MessageForUser[] {
  if (!clientMessageId) return list;
  return list.map((message) =>
    message.clientMessageId === clientMessageId ? { ...message, deliveryState: 'failed' as DeliveryState } : message,
  );
}

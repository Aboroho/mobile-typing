import { canMarkDelivered, nextDeliveryState, otherParticipant } from '@mt/domain';
import type { Conversation, DeliveryState, Message } from '@mt/types';
import { nowIso } from '@mt/utils';
import { getData, type UserRecord } from '../data';
import { publish, topics } from '../realtime/bus';
import { requireParticipant } from './conversation-service';

/**
 * Delivery and read receipts.
 *
 * State model (see docs/messaging-sync.md):
 *
 *   sending ──▶ sent ──▶ delivered ──▶ read
 *      │
 *      └──▶ failed ──▶ sending (retry, same clientMessageId)
 *
 * `sending`/`failed` exist only in the sender's browser. The server creates a
 * message as `sent`; only the *recipient* can move it to `delivered` (their
 * device synchronised it) and `read` (it was rendered in a visible, focused
 * window, or sits below such a message in the thread). States never move
 * backwards, and repeated receipts are no-ops that write nothing.
 */
export interface ReceiptResult {
  /** Number of messages whose state actually changed. */
  updated: number;
  /** Ids of those messages, so the caller can mirror the change locally. */
  messageIds: string[];
}

/**
 * Recipient side acknowledgement for an explicit set of messages.
 *
 * `delivered` means "this participant's device has synchronised the message"
 * and is sent by the recipient's client as soon as it receives the message
 * (through the live stream or a page fetch), whether or not it is on screen.
 * `read` is normally reported through the watermark in `markConversationRead`;
 * explicit read receipts stay supported for clients that prefer per-message
 * reporting.
 *
 * Only the *other* participant may advance a message (`canMarkDelivered`), the
 * state only moves forward (`nextDeliveryState`), and the event published to the
 * author lists exactly the messages that changed — a repeated receipt is a
 * silent no-op with no write and no event.
 */
export async function markDelivered(input: {
  actor: UserRecord;
  conversationId: string;
  messageIds: string[];
  state: 'delivered' | 'read';
}): Promise<ReceiptResult> {
  const data = await getData();
  const conversation = await requireParticipant(input.conversationId, input.actor.id);
  const now = nowIso();
  const changed: Message[] = [];

  for (const messageId of Array.from(new Set(input.messageIds))) {
    const message = await data.messages.getById(messageId);
    if (!message || message.conversationId !== input.conversationId) continue;
    if (!canMarkDelivered(message, input.actor.id)) continue;
    const nextState: DeliveryState = nextDeliveryState(message.deliveryState, input.state);
    if (nextState === message.deliveryState) continue;
    changed.push({ ...message, deliveryState: nextState });
  }

  if (changed.length === 0) return { updated: 0, messageIds: [] };

  await data.messages.updateMany(input.conversationId, changed, (message) => ({
    deliveryState: message.deliveryState,
    deliveredAt: message.deliveredAt ?? now,
    readBy: input.state === 'read' ? Array.from(new Set([...message.readBy, input.actor.id])) : message.readBy,
    readAt: input.state === 'read' ? (message.readAt ?? now) : message.readAt,
  }));

  if (input.state === 'read') {
    await advanceReadState(conversation, input.actor.id, newestCreatedAt(changed), now);
  }
  publish(topics.messages(input.conversationId), 'message.delivery', {
    conversationId: input.conversationId,
    messageIds: changed.map((message) => message.id),
    state: input.state,
    at: now,
    userId: input.actor.id,
    otherUserId: otherParticipant(conversation, input.actor.id),
  });
  return { updated: changed.length, messageIds: changed.map((message) => message.id) };
}

/** Upper bound on messages one read watermark advances in a single request. */
const READ_WATERMARK_BATCH = 200;

/**
 * Read receipts by watermark: everything the peer sent at or before
 * `lastReadMessageAt` counts as read. The client only reports a watermark for a
 * message that was actually rendered in a visible, focused window, so older
 * messages above it in the same thread are exactly the "read range" — the same
 * rule messaging apps apply when a thread is opened and scrolled.
 *
 * Returns the ids that changed; nothing is written or published for a
 * watermark that advances no message.
 */
export async function markReadUpTo(input: {
  actor: UserRecord;
  conversationId: string;
  lastReadMessageAt: string;
}): Promise<ReceiptResult> {
  const data = await getData();
  const conversation = await requireParticipant(input.conversationId, input.actor.id);
  const peerId = otherParticipant(conversation, input.actor.id);
  const now = nowIso();

  const pending = await data.messages.listPendingReadReceipts({
    conversationId: input.conversationId,
    senderId: peerId,
    upTo: input.lastReadMessageAt,
    limit: READ_WATERMARK_BATCH,
  });
  // `canMarkDelivered` is what the explicit path enforces; keep both paths on
  // the same rule even though the query already excludes the reader's messages.
  const changed = pending.filter((message) => canMarkDelivered(message, input.actor.id));

  if (changed.length > 0) {
    await data.messages.updateMany(input.conversationId, changed, (message) => ({
      deliveryState: 'read',
      deliveredAt: message.deliveredAt ?? now,
      readBy: Array.from(new Set([...message.readBy, input.actor.id])),
      readAt: message.readAt ?? now,
    }));
  }
  await advanceReadState(conversation, input.actor.id, input.lastReadMessageAt, now);

  if (changed.length > 0) {
    publish(topics.messages(input.conversationId), 'message.delivery', {
      conversationId: input.conversationId,
      messageIds: changed.map((message) => message.id),
      state: 'read',
      at: now,
      userId: input.actor.id,
      otherUserId: peerId,
    });
  }
  return { updated: changed.length, messageIds: changed.map((message) => message.id) };
}

/**
 * Moves the reader's bookkeeping forward — never backwards, so a stale request
 * from a second tab cannot un-read the conversation.
 */
async function advanceReadState(
  conversation: Conversation,
  userId: string,
  lastReadMessageAt: string | null,
  now: string,
): Promise<void> {
  const data = await getData();
  const current = conversation.participants[userId]?.lastReadMessageAt ?? null;
  const next =
    lastReadMessageAt && (!current || new Date(lastReadMessageAt).getTime() > new Date(current).getTime())
      ? lastReadMessageAt
      : current;
  await data.conversations.updateParticipant(conversation.id, userId, {
    lastReadAt: now,
    lastReadMessageAt: next,
    unreadCount: 0,
    hidden: false,
    hiddenAt: null,
  });
}

function newestCreatedAt(messages: readonly Message[]): string | null {
  let newest: string | null = null;
  for (const message of messages) {
    if (!newest || new Date(message.createdAt).getTime() > new Date(newest).getTime()) newest = message.createdAt;
  }
  return newest;
}

/**
 * "Read up to here": clears the reader's unread counter and advances every
 * peer message at or before the watermark to `read` (see `markReadUpTo`). The
 * peer is told through
 * `message.delivery` (per message) and `conversation.read` (the watermark).
 */
export async function markConversationRead(input: {
  actor: UserRecord;
  conversationId: string;
  lastReadMessageAt: string;
}): Promise<ReceiptResult> {
  const conversation = await requireParticipant(input.conversationId, input.actor.id);
  const result = await markReadUpTo({
    actor: input.actor,
    conversationId: input.conversationId,
    lastReadMessageAt: input.lastReadMessageAt,
  });
  publish(topics.conversation(input.conversationId), 'conversation.read', {
    conversationId: input.conversationId,
    userId: input.actor.id,
    lastReadMessageAt: input.lastReadMessageAt,
    messageIds: result.messageIds,
    at: nowIso(),
    otherUserId: otherParticipant(conversation, input.actor.id),
  });
  return result;
}

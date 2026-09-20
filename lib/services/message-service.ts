import {
  AppError,
  buildReplyPreview,
  canDeleteMessage,
  canEditMessage,
  canMarkDelivered,
  emptyParticipantState,
  messagePreviewFor,
  nextDeliveryState,
  otherParticipant,
  sanitizeMessageText,
  toMessageForUser,
  touchConversation,
} from '@mt/domain';
import type { CallView, Conversation, Cursor,
  DeliveryState,
  Media,
  Message,
  MessageForUser,
  MessageType } from '@mt/types';
import { newId, nowIso } from '@mt/utils';
import type { SendMessageResponse } from '@mt/api-client';
import { getData, isUniqueConstraintError, type UserRecord } from '../data';
import { topics } from '../realtime/bus';
import { persistOutbox, publishEvent, publishLive } from '../realtime/outbox';
import { logger } from '../logger';
import { getConversationView, requireParticipant } from './conversation-service';
import { buildMediaView } from './media-view';

export interface MessageContext {
  actor: UserRecord;
}

/** Maps a stored message to the shape a participant may see. */
export function toVisibleMessage(message: Message, viewerId: string): MessageForUser {
  const media = message.media as Media | null;
  const withMedia: Message = {
    ...message,
    media: buildMediaView(media, viewerId),
  };
  return toMessageForUser(withMedia, viewerId);
}

export function isVisibleTo(message: Message, viewerId: string): boolean {
  if (message.hiddenForUserIds.includes(viewerId)) return false;
  return true;
}

/**
 * Notify-first delivery.
 *
 * A sent message is pushed to the live transport (WebSocket / SSE) the moment
 * it passes authorisation — *before* anything is written to the database — so
 * the recipient sees it as fast as the socket can carry it. Persistence then
 * runs as a write-behind job: message row, media link, conversation summary,
 * durable outbox rows, in that order. The database catching up must never gate
 * delivery.
 *
 * The flip side is handled explicitly too: when the insert fails, the message
 * that was already delivered is retracted — both clients receive
 * `message.retracted` and remove (or mark retryable) the bubble — so a
 * delivery never outlives its storage.
 *
 * Idempotency on the hot path comes from an in-process registry keyed by
 * `(conversationId, senderId, clientMessageId)`: retries return the original
 * response without re-delivering. The database unique constraint on the same
 * triple is the backstop across processes; a duplicate that loses the race is
 * recognised during persistence and dropped instead of delivered twice.
 */
const RECENT_SENDS_KEY = '__mt_recent_sends_v1';
const RECENT_SEND_TTL_MS = 10 * 60_000;
const RECENT_SEND_LIMIT = 4_000;

interface RecentSend {
  messageId: string;
  at: number;
  /** Resolves to the response; shared by every retry of the same send. */
  response: Promise<SendMessageResponse>;
}

type RecentSendMap = Map<string, RecentSend>;

function recentSends(): RecentSendMap {
  const target = globalThis as unknown as Record<string, RecentSendMap | undefined>;
  if (!target[RECENT_SENDS_KEY]) target[RECENT_SENDS_KEY] = new Map();
  return target[RECENT_SENDS_KEY] as RecentSendMap;
}

function lookupRecentSend(key: string): RecentSend | null {
  const entry = recentSends().get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > RECENT_SEND_TTL_MS) {
    recentSends().delete(key);
    return null;
  }
  return entry;
}

function rememberRecentSend(key: string, entry: RecentSend): void {
  const map = recentSends();
  if (map.size >= RECENT_SEND_LIMIT) {
    const now = Date.now();
    for (const [candidateKey, candidate] of map) {
      if (now - candidate.at > RECENT_SEND_TTL_MS) map.delete(candidateKey);
    }
    while (map.size >= RECENT_SEND_LIMIT) {
      // Map iteration order is insertion order — evict the oldest first.
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, entry);
}

function forgetRecentSend(key: string): void {
  recentSends().delete(key);
}

/** In-flight write-behind jobs, so tests and shutdown can wait them out. */
const pendingMessageWrites = new Set<Promise<void>>();

/** Resolves once every write-behind persistence job currently in flight has settled. */
export async function waitForPendingMessageWrites(): Promise<void> {
  while (pendingMessageWrites.size > 0) {
    await Promise.allSettled(Array.from(pendingMessageWrites));
  }
}

/** Test helper: drops the idempotency registry and waits for in-flight writes. */
export async function resetMessageWriteBehind(): Promise<void> {
  await waitForPendingMessageWrites();
  recentSends().clear();
}

function trackWriteBehind(job: Promise<void>): void {
  const tracked = job.catch(() => undefined);
  pendingMessageWrites.add(tracked);
  void tracked.finally(() => pendingMessageWrites.delete(tracked));
}

export async function sendMessage(input: {
  actor: UserRecord;
  conversationId: string;
  type: MessageType;
  text?: string;
  mediaId?: string;
  viewOnce?: boolean;
  clientMessageId: string;
  replyToMessageId?: string;
  /** Set for call records written into the conversation history. */
  call?: CallView;
}): Promise<SendMessageResponse> {
  const data = await getData();
  const conversation = await requireParticipant(input.conversationId, input.actor.id);
  const recipientId = otherParticipant(conversation, input.actor.id);

  // Idempotency without a database round-trip: a retry with the same
  // clientMessageId returns the original response and never re-delivers.
  const registryKey = `${input.conversationId}|${input.actor.id}|${input.clientMessageId}`;
  const recent = lookupRecentSend(registryKey);
  if (recent) return recent.response;

  const now = nowIso();
  let text: string | null = null;
  if (input.type === 'text') {
    text = sanitizeMessageText(input.text ?? '');
    if (!text.trim()) throw new AppError('BAD_REQUEST', 'message cannot be empty');
  } else if (input.text) {
    text = sanitizeMessageText(input.text);
  }

  let mediaRecord: Media | null = null;
  if (input.mediaId) {
    const media = await data.media.getById(input.mediaId);
    if (!media) throw AppError.notFound('upload not found');
    if (media.ownerId !== input.actor.id) throw AppError.forbidden('that upload belongs to someone else');
    if (media.kind !== input.type) throw new AppError('BAD_REQUEST', 'attachment type mismatch');
    mediaRecord = media;
  }

  const replyTo = input.replyToMessageId
    ? await buildReplyReference(input.conversationId, input.replyToMessageId)
    : null;

  const recipientState = conversation.participants[recipientId];
  const blockedByRecipient = recipientState?.blockedUserIds.includes(input.actor.id) ?? false;

  const message: Message = {
    id: newId('m'),
    conversationId: input.conversationId,
    senderId: input.actor.id,
    type: input.type,
    text,
    media: mediaRecord
      ? {
          mediaId: mediaRecord.id,
          kind: mediaRecord.kind,
          mimeType: mediaRecord.mimeType,
          sizeBytes: mediaRecord.sizeBytes,
          width: mediaRecord.width,
          height: mediaRecord.height,
          durationMs: mediaRecord.durationMs,
          viewOnce: Boolean(input.viewOnce),
          viewOnceState: input.viewOnce ? 'delivered' : null,
          canView: true,
          contentUrl: null,
          signedUrl: null,
          deleted: false,
        }
      : null,
    call: input.call ?? null,
    replyTo,
    deliveryState: 'sent',
    deliveredAt: null,
    readBy: [],
    readAt: null,
    edited: false,
    editedAt: null,
    editHistory: [],
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    hiddenForUserIds: [],
    clientMessageId: input.clientMessageId,
    expiresAt: null,
    metadata: (blockedByRecipient ? { blockedByRecipient: true } : {}) as Message['metadata'],
    createdAt: now,
    updatedAt: now,
  };

  const recipients = [
    {
      userId: recipientId,
      payload: {
        eventId: message.id,
        conversationId: input.conversationId,
        message: toVisibleMessage(message, recipientId),
        forUserId: recipientId,
      },
    },
    {
      userId: input.actor.id,
      payload: {
        eventId: message.id,
        conversationId: input.conversationId,
        message: toVisibleMessage(message, input.actor.id),
        forUserId: input.actor.id,
      },
    },
  ];

  // Register before any await: a retry racing this send must see the entry the
  // moment the message exists, or it would deliver a second time.
  const responsePromise = buildSendResponse(conversation, message, recipientId, input.actor.id);
  rememberRecentSend(registryKey, { messageId: message.id, at: Date.now(), response: responsePromise });

  // 1) Notify first. Delivery to both participants happens right now, on the
  //    live transport, and does not wait for a single database write.
  publishLive({
    topic: topics.messages(input.conversationId),
    type: 'message.created',
    recipients,
  });

  // 2) The database catches up in the background. If it cannot, the message
  //    that was just delivered is retracted on every client.
  trackWriteBehind(
    persistSentMessage({
      message,
      mediaRecord,
      conversationId: input.conversationId,
      actorId: input.actor.id,
      recipientId,
      viewOnce: Boolean(input.viewOnce),
      registryKey,
      recipients,
    }),
  );

  return responsePromise;
}

/** The REST response for a send; the only awaited part is one summary read. */
async function buildSendResponse(
  conversation: Conversation,
  message: Message,
  recipientId: string,
  actorId: string,
): Promise<SendMessageResponse> {
  return {
    message: toVisibleMessage(message, actorId),
    conversation: await getConversationView(
      projectConversationAfterSend(conversation, message, recipientId),
      actorId,
    ),
  };
}

/** The conversation row as it will look once the send is persisted. */
function projectConversationAfterSend(
  conversation: Conversation,
  message: Message,
  recipientId: string,
): Conversation {
  const state = conversation.participants[recipientId] ?? emptyParticipantState();
  return touchConversation({
    ...conversation,
    lastMessage: messagePreviewFor(message, recipientId),
    lastMessageAt: message.createdAt,
    participants: {
      ...conversation.participants,
      [recipientId]: { ...state, unreadCount: state.unreadCount + 1, hidden: false, hiddenAt: null },
    },
  });
}

/**
 * Write-behind persistence for a message that has already been delivered live.
 *
 * Order matters: the message row first (it is what catch-up replays and
 * pagination read), then the media link and the conversation summary, then the
 * durable outbox rows, and finally a lightweight `conversation.updated` fan-out
 * so both participants' conversation lists refresh without a round-trip.
 * Any failure triggers a retraction of the already-delivered message.
 */
async function persistSentMessage(job: {
  message: Message;
  mediaRecord: Media | null;
  conversationId: string;
  actorId: string;
  recipientId: string;
  viewOnce: boolean;
  registryKey: string;
  recipients: Array<{ userId: string; payload: unknown }>;
}): Promise<void> {
  const data = await getData();
  try {
    try {
      await data.messages.create(job.message);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // A send with the same (conversationId, senderId, clientMessageId)
        // already has a row — the original delivery stands, this one is a
        // duplicate that must not be delivered again.
        logger.info('message.persist_duplicate', {
          messageId: job.message.id,
          clientMessageId: job.message.clientMessageId,
        });
        return;
      }
      throw error;
    }

    if (job.mediaRecord) {
      // A view-once photo starts at `delivered`, not `sent`: storing the message
      // is the delivery, because the recipient's client pulls it from the
      // message stream. Without this the recipient could never claim their
      // single view.
      await data.media.update(job.mediaRecord.id, {
        conversationId: job.conversationId,
        messageId: job.message.id,
        viewOnce: job.viewOnce,
        viewOnceState: job.viewOnce ? 'delivered' : null,
      });
    }

    const updatedConversation = await data.conversations.update(job.conversationId, {
      lastMessage: messagePreviewFor(job.message, job.recipientId),
      lastMessageAt: job.message.createdAt,
      lastActivityAt: job.message.createdAt,
    });
    let stored = updatedConversation;
    if (updatedConversation) {
      stored =
        (await data.conversations.updateParticipant(job.conversationId, job.recipientId, {
          unreadCount: (updatedConversation.participants[job.recipientId]?.unreadCount ?? 0) + 1,
          hidden: false,
          hiddenAt: null,
        })) ?? updatedConversation;
    }

    // Durability for reconnects: replay rows for the event that was just
    // published live. Kept after the message write so a replay never points at
    // a message pagination cannot find.
    await persistOutbox({
      topic: topics.messages(job.conversationId),
      type: 'message.created',
      recipients: job.recipients,
    });

    // Refresh both conversation lists live (preview, timestamp, unread badge).
    if (stored) {
      for (const userId of stored.participantIds) {
        const view = await getConversationView(stored, userId);
        publishLive({
          topic: topics.conversation(job.conversationId),
          type: 'conversation.updated',
          recipients: [
            {
              userId,
              payload: {
                eventId: `conversation_updated_${job.message.id}_${userId}`,
                conversationId: job.conversationId,
                conversation: view,
                forUserId: userId,
              },
            },
          ],
        });
      }
    }
  } catch (error) {
    logger.error('message.persist_failed', {
      messageId: job.message.id,
      conversationId: job.conversationId,
      error: String(error),
    });
    await retractDeliveredMessage(job, 'storage_failed');
  }
}

/**
 * Undoes a delivery whose storage failed: any partial write is cleaned up on a
 * best-effort basis, the idempotency entry is dropped so a retry starts fresh,
 * and every client that received the message is told to take it back. The
 * sender's client keeps the bubble in a failed state so it can be retried.
 */
async function retractDeliveredMessage(
  job: { message: Message; conversationId: string; actorId: string; recipientId: string; registryKey: string },
  reason: string,
): Promise<void> {
  forgetRecentSend(job.registryKey);
  try {
    const data = await getData();
    const stored = await data.messages.getById(job.message.id);
    if (stored && !stored.deleted) {
      await data.messages.update(job.message.id, {
        deleted: true,
        deletedAt: nowIso(),
        deletedBy: 'system',
        text: null,
        hiddenForUserIds: Array.from(new Set([job.actorId, job.recipientId])),
      });
    }
  } catch {
    // The row may never have been written — that is the failure we are
    // handling. Nothing left to clean up.
  }

  publishLive({
    topic: topics.messages(job.conversationId),
    type: 'message.retracted',
    recipients: [job.recipientId, job.actorId].map((userId) => ({
      userId,
      payload: {
        eventId: `retracted_${job.message.id}_${userId}`,
        conversationId: job.conversationId,
        messageId: job.message.id,
        clientMessageId: job.message.clientMessageId,
        senderId: job.message.senderId,
        reason,
        forUserId: userId,
      },
    })),
  });
}

async function buildReplyReference(conversationId: string, messageId: string) {
  const data = await getData();
  const referenced = await data.messages.getById(messageId);
  if (!referenced || referenced.conversationId !== conversationId) {
    throw AppError.notFound('the message you are replying to does not exist');
  }
  return {
    messageId: referenced.id,
    senderId: referenced.senderId,
    type: referenced.type,
    preview: buildReplyPreview(referenced),
    createdAt: referenced.createdAt,
  };
}

/**
 * Edits are only possible inside the 2 minute window and only by the author.
 * The previous text is retained in `editHistory` for administrative inspection.
 */
export async function editMessage(input: {
  actor: UserRecord;
  messageId: string;
  text: string;
}): Promise<SendMessageResponse> {
  const data = await getData();
  const message = await data.messages.getById(input.messageId);
  if (!message) throw AppError.notFound('message not found');
  await requireParticipant(message.conversationId, input.actor.id);

  // Authorship is an authorisation question (403); the edit window is a state
  // question (412), so a client can tell "never yours" from "too late".
  if (message.senderId !== input.actor.id) {
    throw AppError.forbidden('only the author can edit a message');
  }
  const check = canEditMessage({ message, actorId: input.actor.id });
  if (!check.allowed) {
    throw new AppError('PRECONDITION_FAILED', check.reason ?? 'message cannot be edited');
  }

  const now = nowIso();
  const nextText = sanitizeMessageText(input.text);
  if (!nextText.trim()) throw new AppError('BAD_REQUEST', 'message cannot be empty');

  const updated = await data.messages.update(input.messageId, {
    text: nextText,
    edited: true,
    editedAt: now,
    editHistory: [
      ...message.editHistory,
      { previousText: message.text ?? '', editedAt: now, editedBy: input.actor.id },
    ],
  });
  if (!updated) throw AppError.notFound('message not found');

  const conversation = await data.conversations.getById(message.conversationId);
  if (conversation?.lastMessage?.messageId === message.id) {
    await data.conversations.update(conversation.id, {
      lastMessage: messagePreviewFor(updated, otherParticipant(conversation, input.actor.id)),
    });
  }

  await publishEvent({
    topic: topics.messages(message.conversationId),
    type: 'message.updated',
    recipients: conversation
      ? conversation.participantIds.map((userId) => ({
          userId,
          payload: {
            eventId: `updated_${updated.id}_${updated.updatedAt}`,
            conversationId: message.conversationId,
            message: toVisibleMessage(updated, userId),
            forUserId: userId,
          },
        }))
      : [],
  });

  return {
    message: toVisibleMessage(updated, input.actor.id),
    conversation: await getConversationView(
      (await data.conversations.getById(message.conversationId))!,
      input.actor.id,
    ),
  };
}

/**
 * Soft deletion. `everyone` clears the visible content for both participants but
 * keeps the row (and the original text) for administrators; `me` only hides the
 * row for the caller.
 */
export async function deleteMessage(input: {
  actor: UserRecord;
  messageId: string;
  scope: 'everyone' | 'me';
  reason?: string;
}): Promise<void> {
  const data = await getData();
  const message = await data.messages.getById(input.messageId);
  if (!message) throw AppError.notFound('message not found');
  await requireParticipant(message.conversationId, input.actor.id);

  if (input.scope === 'me') {
    const hiddenFor = new Set(message.hiddenForUserIds);
    hiddenFor.add(input.actor.id);
    await data.messages.update(input.messageId, { hiddenForUserIds: Array.from(hiddenFor) });
  } else {
    const check = canDeleteMessage({ message, actorId: input.actor.id });
    if (!check.allowed) {
      throw new AppError('FORBIDDEN', check.reason ?? 'message cannot be deleted');
    }
    const now = nowIso();
    const originalText = message.text;
    await data.messages.update(input.messageId, {
      deleted: true,
      deletedAt: now,
      deletedBy: input.actor.id,
      text: null,
      metadata: {
        ...message.metadata,
        deletionReason: input.reason ?? null,
        originalText: originalText ?? null,
      },
    });
    if (message.media) {
      await data.media.update(message.media.mediaId, {
        deleted: true,
        deletedAt: now,
        deletedBy: input.actor.id,
        viewOnceState: message.media.viewOnce ? 'deleted' : null,
      });
    }
  }

  const updated = await data.messages.getById(input.messageId);
  const conversation = await data.conversations.getById(message.conversationId);
  if (updated && conversation?.lastMessage?.messageId === message.id) {
    await data.conversations.update(conversation.id, {
      lastMessage: messagePreviewFor(updated, otherParticipant(conversation, input.actor.id)),
    });
  }
  if (updated && conversation) {
    const recipients =
      input.scope === 'me'
        ? [input.actor.id]
        : conversation.participantIds.filter((userId) => userId !== input.actor.id);
    await publishEvent({
      topic: topics.messages(message.conversationId),
      type: 'message.deleted',
      recipients: recipients.map((userId) => ({
        userId,
        payload: {
          eventId: `deleted_${message.id}_${input.scope}_${userId}`,
          conversationId: message.conversationId,
          messageId: message.id,
          scope: input.scope,
          actorId: input.actor.id,
          forUserId: userId,
        },
      })),
    });
  }
  logger.info('message.deleted', { scope: input.scope, messageId: input.messageId });
}

export async function listMessages(input: {
  viewerId: string;
  conversationId: string;
  limit: number;
  before?: string;
  after?: string;
  q?: string;
}): Promise<Cursor<MessageForUser>> {
  const data = await getData();
  await requireParticipant(input.conversationId, input.viewerId);
  const page = await data.messages.list({
    conversationId: input.conversationId,
    limit: input.limit,
    before: input.before,
    after: input.after,
  });
  const filtered = page.items.filter((message) => isVisibleTo(message, input.viewerId));
  const query = input.q?.trim().toLowerCase();
  const searched = query
    ? filtered.filter((message) => (message.text ?? '').toLowerCase().includes(query))
    : filtered;
  return {
    ...page,
    items: searched.map((message) => toVisibleMessage(message, input.viewerId)),
  };
}

/**
 * Recipient-side acknowledgement: sent → delivered → read.
 *
 * Only the intended recipient may move a receipt forward (`canMarkDelivered`
 * checks both conversation membership and that the actor is *not* the sender),
 * the transition is monotonic, and a message whose state already matches is
 * skipped so a chatty client cannot rewrite identical rows. The resulting
 * change is fanned out to the sender over the durable outbox.
 */
export async function markDelivered(input: {
  actor: UserRecord;
  conversationId: string;
  messageIds: string[];
  state: 'delivered' | 'read';
}): Promise<number> {
  const data = await getData();
  const conversation = await requireParticipant(input.conversationId, input.actor.id);
  const now = nowIso();
  const updatedMessageIds: string[] = [];
  // One id per message; a huge batch would otherwise become a long serial loop.
  const uniqueIds = Array.from(new Set(input.messageIds)).slice(0, 100);

  for (const messageId of uniqueIds) {
    const message = await data.messages.getById(messageId);
    if (!message || message.conversationId !== input.conversationId) continue;
    if (!canMarkDelivered(message, input.actor.id)) continue;
    const nextState: DeliveryState = nextDeliveryState(message.deliveryState, input.state);
    if (nextState === message.deliveryState) continue;
    const updated = await data.messages.update(messageId, {
      deliveryState: nextState,
      deliveredAt: message.deliveredAt ?? now,
      readBy: input.state === 'read' ? Array.from(new Set([...message.readBy, input.actor.id])) : message.readBy,
      readAt: input.state === 'read' ? now : message.readAt,
    });
    if (updated) updatedMessageIds.push(messageId);
  }

  if (updatedMessageIds.length > 0) {
    if (input.state === 'read') {
      await data.conversations.updateParticipant(input.conversationId, input.actor.id, {
        lastReadAt: now,
        lastReadMessageAt: now,
        unreadCount: 0,
      });
    }
    const senderId = otherParticipant(conversation, input.actor.id);
    await publishEvent({
      topic: topics.messages(input.conversationId),
      type: input.state === 'read' ? 'message.read' : 'message.delivered',
      recipients: [
        {
          userId: senderId,
          payload: {
            eventId: `${input.state}_${input.conversationId}_${input.actor.id}_${updatedMessageIds.join(',')}`,
            conversationId: input.conversationId,
            messageIds: updatedMessageIds,
            state: input.state,
            userId: input.actor.id,
            otherUserId: senderId,
          },
        },
      ],
    });
  }
  return updatedMessageIds.length;
}

export async function getVisibleMessage(input: {
  viewerId: string;
  messageId: string;
}): Promise<MessageForUser> {
  const data = await getData();
  const message = await data.messages.getById(input.messageId);
  if (!message) throw AppError.notFound('message not found');
  await requireParticipant(message.conversationId, input.viewerId);
  return toVisibleMessage(message, input.viewerId);
}

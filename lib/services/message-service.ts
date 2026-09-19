import {
  AppError,
  buildReplyPreview,
  canDeleteMessage,
  canEditMessage,
  messagePreviewFor,
  otherParticipant,
  sanitizeMessageText,
  toMessageForUser,
} from '@mt/domain';
import type { CallView, Cursor, Media, Message, MessageForUser, MessageType } from '@mt/types';
import { newId, nowIso } from '@mt/utils';
import type { SendMessageResponse } from '@mt/api-client';
import { getData, type UserRecord } from '../data';
import { publish, topics } from '../realtime/bus';
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

  // Idempotency: a retry with the same clientMessageId returns the original.
  const existing = await data.messages.findByClientMessageId({
    conversationId: input.conversationId,
    senderId: input.actor.id,
    clientMessageId: input.clientMessageId,
  });
  if (existing) {
    return {
      message: toVisibleMessage(existing, input.actor.id),
      conversation: await getConversationView(conversation, input.actor.id),
    };
  }

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
    metadata: blockedByRecipient ? { blockedByRecipient: true } : {},
    createdAt: now,
    updatedAt: now,
  };

  const created = await data.messages.create(message);

  if (mediaRecord) {
    // A view-once photo starts at `delivered`, not `sent`: storing the message is
    // the delivery, because the recipient's client pulls it from the message
    // stream. Without this the recipient could never claim their single view.
    await data.media.update(mediaRecord.id, {
      conversationId: input.conversationId,
      messageId: created.id,
      viewOnce: Boolean(input.viewOnce),
      viewOnceState: input.viewOnce ? 'delivered' : null,
    });
  }

  const updatedConversation = await data.conversations.update(input.conversationId, {
    lastMessage: messagePreviewFor(created, recipientId),
    lastMessageAt: created.createdAt,
    lastActivityAt: created.createdAt,
  });
  if (updatedConversation) {
    await data.conversations.updateParticipant(input.conversationId, recipientId, {
      unreadCount: (updatedConversation.participants[recipientId]?.unreadCount ?? 0) + 1,
      hidden: false,
      hiddenAt: null,
    });
  }

  publish(topics.messages(input.conversationId), 'message.created', {
    conversationId: input.conversationId,
    message: toVisibleMessage(created, recipientId),
    forUserId: recipientId,
  });
  publish(topics.messages(input.conversationId), 'message.created', {
    conversationId: input.conversationId,
    message: toVisibleMessage(created, input.actor.id),
    forUserId: input.actor.id,
  });

  return {
    message: toVisibleMessage(created, input.actor.id),
    conversation: await getConversationView(
      (await data.conversations.getById(input.conversationId)) ?? conversation,
      input.actor.id,
    ),
  };
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

  publish(topics.messages(message.conversationId), 'message.updated', {
    conversationId: message.conversationId,
    message: toVisibleMessage(updated, input.actor.id),
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
  if (updated) {
    publish(topics.messages(message.conversationId), 'message.deleted', {
      conversationId: message.conversationId,
      messageId: message.id,
      scope: input.scope,
      actorId: input.actor.id,
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

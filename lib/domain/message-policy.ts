import {
  DELIVERY_RANK,
  MESSAGE_EDIT_WINDOW_MS,
  MESSAGE_PREVIEW_LENGTH,
  type DeliveryState,
  type Message,
  type MessageForUser,
  type MessagePreview,
  type Timestamp,
} from '@mt/types';
import { truncate } from '@mt/utils';

export const DELETED_MESSAGE_PLACEHOLDER = 'This message was deleted';
export const DELETED_MEDIA_PLACEHOLDER = 'This attachment was deleted';

export interface PolicyCheck {
  allowed: boolean;
  reason: string | null;
}

const ALLOWED: PolicyCheck = { allowed: true, reason: null };
function denied(reason: string): PolicyCheck {
  return { allowed: false, reason };
}

export function isWithinEditWindow(
  createdAt: Timestamp | number,
  nowMs: number = Date.now(),
  editWindowMs: number = MESSAGE_EDIT_WINDOW_MS,
): boolean {
  const created = typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  return nowMs - created <= editWindowMs;
}

/**
 * Only the original author may edit, only inside the 2 minute window, and a
 * deleted message can never be edited back into existence.
 */
export function canEditMessage(options: {
  message: Pick<Message, 'senderId' | 'createdAt' | 'deleted'>;
  actorId: string;
  nowMs?: number;
  editWindowMs?: number;
}): PolicyCheck {
  const { message, actorId } = options;
  if (message.senderId !== actorId) return denied('only the author can edit a message');
  if (message.deleted) return denied('a deleted message cannot be edited');
  if (!isWithinEditWindow(message.createdAt, options.nowMs ?? Date.now(), options.editWindowMs)) {
    return denied('messages can only be edited within 2 minutes of sending');
  }
  return ALLOWED;
}

export function canDeleteMessage(options: {
  message: Pick<Message, 'senderId' | 'deleted'>;
  actorId: string;
}): PolicyCheck {
  const { message, actorId } = options;
  if (message.deleted) return denied('message is already deleted');
  if (message.senderId !== actorId) {
    return denied('only the author can delete a message for everyone');
  }
  return ALLOWED;
}

/**
 * Soft deletion never destroys the row: it flips `deleted` and stores the
 * original text so an administrator can still inspect it. This helper produces
 * the exact patch the persistence layer applies.
 */
export interface SoftDeletePatch {
  deleted: true;
  deletedAt: Timestamp;
  deletedBy: string;
  text: string | null;
  editHistory: Message['editHistory'];
}

export function softDeleteMessage(options: {
  message: Message;
  actorId: string;
  reason: string | null;
  now?: Timestamp;
}): { patch: SoftDeletePatch; reason: string | null } {
  const { message, actorId } = options;
  const now = options.now ?? new Date().toISOString();
  return {
    patch: {
      deleted: true,
      deletedAt: now,
      deletedBy: actorId,
      text: null,
      editHistory: message.editHistory,
    },
    reason: options.reason,
  };
}

/** Delivery state may only move forward; a late "sent" cannot undo a "read". */
export function nextDeliveryState(current: DeliveryState, requested: DeliveryState): DeliveryState {
  // A retry is the only case where the state may move backwards: without this a
  // failed message could never be resent.
  if (current === 'failed') return requested;
  return DELIVERY_RANK[requested] > DELIVERY_RANK[current] ? requested : current;
}

export function canMarkDelivered(message: Pick<Message, 'senderId' | 'deliveryState'>, actorId: string): boolean {
  // The recipient (not the author) advances sent -> delivered -> read.
  return message.senderId !== actorId;
}

/**
 * Strips everything an ordinary participant must not see: full edit history,
 * internal metadata and the content of deleted messages.
 */
export function toMessageForUser(message: Message, viewerId: string): MessageForUser {
  // A message is gone for this viewer if it was deleted outright, or if this
  // viewer deleted it for themselves only (`hiddenForUserIds`).
  const hiddenForViewer = message.deleted || (message.hiddenForUserIds ?? []).includes(viewerId);
  const {
    editHistory: _editHistory,
    metadata: _metadata,
    hiddenForUserIds: _hiddenForUserIds,
    ...rest
  } = message;
  void _editHistory;
  void _metadata;
  void _hiddenForUserIds;
  return {
    ...rest,
    deleted: hiddenForViewer,
    text: hiddenForViewer ? null : message.text,
    media:
      message.media == null
        ? null
        : {
            ...message.media,
            contentUrl: message.media.canView && !hiddenForViewer ? message.media.contentUrl : null,
            signedUrl: message.media.canView && !hiddenForViewer ? message.media.signedUrl : null,
          },
  };
}

export function messagePreviewFor(message: Message, viewerId: string): MessagePreview {
  if (message.type === 'call') {
    return {
      messageId: message.id,
      senderId: message.senderId,
      type: message.type,
      text: message.text ?? 'Audio call',
      deleted: false,
      createdAt: message.createdAt,
    };
  }
  if (message.deleted) {
    return {
      messageId: message.id,
      senderId: message.senderId,
      type: message.type,
      text: message.type === 'text' ? DELETED_MESSAGE_PLACEHOLDER : DELETED_MEDIA_PLACEHOLDER,
      deleted: true,
      createdAt: message.createdAt,
    };
  }
  switch (message.type) {
    case 'text':
      return {
        messageId: message.id,
        senderId: message.senderId,
        type: message.type,
        text: truncate(message.text ?? '', MESSAGE_PREVIEW_LENGTH),
        deleted: false,
        createdAt: message.createdAt,
      };
    case 'image':
      return {
        messageId: message.id,
        senderId: message.senderId,
        type: message.type,
        text: message.media?.viewOnce ? 'Photo (view once)' : 'Photo',
        deleted: false,
        createdAt: message.createdAt,
      };
    case 'voice':
      return {
        messageId: message.id,
        senderId: message.senderId,
        type: message.type,
        text: 'Voice message',
        deleted: false,
        createdAt: message.createdAt,
      };
    default:
      return {
        messageId: message.id,
        senderId: message.senderId,
        type: message.type,
        text: truncate(message.text ?? '', MESSAGE_PREVIEW_LENGTH),
        deleted: false,
        createdAt: message.createdAt,
      };
  }
  void viewerId;
}

export function buildReplyPreview(message: Message): string {
  if (message.deleted) return DELETED_MESSAGE_PLACEHOLDER;
  if (message.type === 'text') return truncate(message.text ?? '', MESSAGE_PREVIEW_LENGTH);
  if (message.type === 'image') return message.media?.viewOnce ? 'Photo (view once)' : 'Photo';
  if (message.type === 'voice') return 'Voice message';
  return truncate(message.text ?? '', MESSAGE_PREVIEW_LENGTH);
}

import type { EntityTimestamps, Timestamp } from './common';
import type { MediaView } from './media';
import type { CallView } from './call';

export const MessageType = {
  Text: 'text',
  Image: 'image',
  Voice: 'voice',
  Call: 'call',
  System: 'system',
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const DeliveryState = {
  Sending: 'sending',
  Sent: 'sent',
  Delivered: 'delivered',
  Read: 'read',
  Failed: 'failed',
} as const;
export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];

/** Terminal delivery states a client may not downgrade. */
export const DELIVERY_RANK: Record<DeliveryState, number> = {
  sending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

export interface ReplyReference {
  messageId: string;
  senderId: string;
  type: MessageType;
  /** Truncated, deletion aware preview — never the full body of a deleted message. */
  preview: string;
  createdAt: Timestamp;
}

export interface MessageEditRecord {
  previousText: string;
  editedAt: Timestamp;
  editedBy: string;
}

export interface MessageDeletion {
  deletedAt: Timestamp;
  deletedBy: string;
  reason: string | null;
  /** Kept for admin inspection; hidden from ordinary users. */
  originalText: string | null;
}

export interface Message extends EntityTimestamps {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  text: string | null;
  media: MediaView | null;
  call: CallView | null;
  replyTo: ReplyReference | null;
  deliveryState: DeliveryState;
  deliveredAt: Timestamp | null;
  readBy: string[];
  readAt: Timestamp | null;
  edited: boolean;
  editedAt: Timestamp | null;
  /** Server keeps the full history; the API strips it for ordinary users. */
  editHistory: MessageEditRecord[];
  deleted: boolean;
  deletedAt: Timestamp | null;
  deletedBy: string | null;
  /** "Delete for me": the row stays intact, only these users stop seeing it. */
  hiddenForUserIds: string[];
  /** Client supplied idempotency key so retries never duplicate a message. */
  clientMessageId: string | null;
  expiresAt: Timestamp | null;
  metadata: Record<string, unknown>;
}

/** Compact shape used for conversation list previews and admin search hits. */
export interface MessagePreview {
  messageId: string;
  senderId: string;
  type: MessageType;
  text: string;
  deleted: boolean;
  createdAt: Timestamp;
}

/**
 * What an ordinary participant receives. Edit history and deleted content are
 * removed server side before this shape is produced.
 */
export type MessageForUser = Omit<Message, 'editHistory' | 'metadata' | 'hiddenForUserIds'> & {
  /** Present when the viewer is allowed to know the message was edited. */
  edited: boolean;
};

/** What an administrator receives, including hidden content. */
export interface MessageForAdmin extends Message {
  sender: { id: string; name: string; email: string } | null;
}

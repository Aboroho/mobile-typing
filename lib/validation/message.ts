import { z } from 'zod';
import { MESSAGE_MAX_LENGTH, MESSAGE_PAGE_SIZE } from '@mt/types';
import { idSchema } from './common';

export const replyReferenceInputSchema = z.object({
  messageId: idSchema,
});

export const sendMessageSchema = z.object({
  conversationId: idSchema,
  type: z.enum(['text', 'image', 'voice']),
  text: z
    .string()
    .max(MESSAGE_MAX_LENGTH, `message must be at most ${MESSAGE_MAX_LENGTH} characters`)
    .optional(),
  /** Idempotency key so a retried send cannot create a duplicate message. */
  clientMessageId: z.string().min(8).max(64),
  replyTo: replyReferenceInputSchema.optional(),
  /** Set for images; created by `POST /api/v1/media/upload-intent`. */
  mediaId: idSchema.optional(),
  viewOnce: z.boolean().optional(),
}).refine(
  (value) => {
    if (value.type === 'text') return typeof value.text === 'string' && value.text.trim().length > 0;
    return Boolean(value.mediaId);
  },
  { message: 'text messages need text, media messages need a mediaId' },
);

export const editMessageSchema = z.object({
  text: z
    .string()
    .min(1, 'message cannot be empty')
    .max(MESSAGE_MAX_LENGTH, `message must be at most ${MESSAGE_MAX_LENGTH} characters`),
});

export const deleteMessageSchema = z.object({
  /** Optional free-form reason; stored for admin inspection only. */
  reason: z.string().max(200).optional(),
  /** `everyone` hides it from both participants, `me` only from the caller. */
  scope: z.enum(['everyone', 'me']).default('everyone'),
});

export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(MESSAGE_PAGE_SIZE),
  /** Messages strictly older than this ISO timestamp. */
  before: z.string().datetime().optional(),
  /** Messages strictly newer than this ISO timestamp (used by the live tail). */
  after: z.string().datetime().optional(),
  q: z.string().trim().max(64).optional(),
});

export const markDeliveredSchema = z.object({
  messageIds: z.array(idSchema).min(1).max(100),
  state: z.enum(['delivered', 'read']),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type DeleteMessageInput = z.input<typeof deleteMessageSchema>;
export type ListMessagesInput = z.input<typeof listMessagesQuerySchema>;
export type MarkDeliveredInput = z.infer<typeof markDeliveredSchema>;

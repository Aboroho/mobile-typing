import { z } from 'zod';
import { idSchema, paginationSchema } from './common';

export const createConversationSchema = z.object({
  participantId: idSchema,
});

export const listConversationsQuerySchema = paginationSchema.extend({
  includeHidden: z.coerce.boolean().optional(),
});

export const markConversationReadSchema = z.object({
  /** Messages with `createdAt <= lastReadMessageAt` count as read. */
  lastReadMessageAt: z.string().datetime(),
  lastReadMessageId: idSchema.optional(),
});

export const hideConversationSchema = z.object({
  hidden: z.boolean(),
});

export const blockUserSchema = z.object({
  blockedUserId: idSchema,
  blocked: z.boolean(),
});

export const typingIndicatorSchema = z.object({
  isTyping: z.boolean(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type ListConversationsInput = z.input<typeof listConversationsQuerySchema>;
export type MarkConversationReadInput = z.infer<typeof markConversationReadSchema>;
export type HideConversationInput = z.infer<typeof hideConversationSchema>;
export type BlockUserInput = z.infer<typeof blockUserSchema>;
export type TypingIndicatorInput = z.infer<typeof typingIndicatorSchema>;

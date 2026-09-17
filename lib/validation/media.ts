import { z } from 'zod';
import { IMAGE_MAX_BYTES, VOICE_MAX_BYTES, VOICE_MAX_DURATION_MS } from '@mt/types';
import { idSchema } from './common';

export const createMediaIntentSchema = z.object({
  kind: z.enum(['image', 'voice']),
  mimeType: z.string().min(3).max(64),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .refine((value) => value <= Math.max(IMAGE_MAX_BYTES, VOICE_MAX_BYTES), 'file is too large'),
  /** Voice messages only. */
  durationMs: z.number().int().min(0).max(VOICE_MAX_DURATION_MS).optional(),
  width: z.number().int().min(1).max(20_000).optional(),
  height: z.number().int().min(1).max(20_000).optional(),
});

export const sendMediaMessageSchema = z.object({
  conversationId: idSchema,
  mediaId: idSchema,
  type: z.enum(['image', 'voice']),
  caption: z.string().max(2000).optional(),
  clientMessageId: z.string().min(8).max(64),
  viewOnce: z.boolean().optional(),
});

export const markMediaViewedSchema = z.object({
  mediaId: idSchema,
});

export const deleteMediaSchema = z.object({
  reason: z.string().max(200).optional(),
});

export type CreateMediaIntentInput = z.infer<typeof createMediaIntentSchema>;
export type SendMediaMessageInput = z.infer<typeof sendMediaMessageSchema>;

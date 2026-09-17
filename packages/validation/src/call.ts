import { z } from 'zod';
import { idSchema } from './common';

export const createCallSchema = z.object({
  conversationId: idSchema,
  type: z.enum(['audio']).default('audio'),
});

export const signalCallSchema = z.object({
  kind: z.enum(['offer', 'answer', 'ice-candidate', 'mute', 'unmute', 'bye']),
  /** Serialised WebRTC payload (SDP or ICE candidate). Validated for shape. */
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const acceptCallSchema = z.object({});
export const rejectCallSchema = z.object({ reason: z.string().max(64).optional() });

export const endCallSchema = z.object({
  reason: z
    .enum(['hangup', 'rejected', 'cancelled', 'timeout', 'privacy_lock', 'network', 'error'])
    .default('hangup'),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
});

export const listCallsQuerySchema = z.object({
  conversationId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().nullish(),
});

export type CreateCallInput = z.input<typeof createCallSchema>;
export type SignalCallInput = z.input<typeof signalCallSchema>;
export type EndCallInput = z.input<typeof endCallSchema>;
export type ListCallsInput = z.input<typeof listCallsQuerySchema>;

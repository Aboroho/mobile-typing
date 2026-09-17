import { z } from 'zod';
import { idSchema, paginationSchema, searchQuerySchema } from './common';
import { secretCodeSchema } from './access';

export const changeSecretCodeSchema = z.object({
  code: secretCodeSchema,
  /** Administrators must retype the code; guards against typos that lock everyone out. */
  confirmCode: secretCodeSchema,
  /**
   * `rotate` (default) invalidates every existing access session, `replace`
   * keeps them. Rotation is the secure default.
   */
  strategy: z.enum(['rotate', 'replace']).default('rotate'),
}).refine((value) => value.code === value.confirmCode, {
  message: 'confirmation does not match',
  path: ['confirmCode'],
});

export const adminListUsersSchema = paginationSchema.extend({
  q: z.string().trim().max(64).optional(),
  status: z.enum(['active', 'disabled', 'deleted']).optional(),
});

export const adminUpdateUserStatusSchema = z.object({
  status: z.enum(['active', 'disabled']),
  reason: z.string().max(200).optional(),
});

export const adminInspectConversationSchema = z.object({
  participantA: idSchema,
  participantB: idSchema,
});

export const adminListMessagesSchema = paginationSchema.extend({
  q: z.string().trim().max(64).optional(),
  includeDeleted: z.coerce.boolean().default(true),
});

export const adminListMediaSchema = paginationSchema.extend({
  kind: z.enum(['image', 'voice']).optional(),
  includeDeleted: z.coerce.boolean().default(true),
  viewOnceOnly: z.coerce.boolean().optional(),
});

export const adminAuditQuerySchema = paginationSchema.extend({
  action: z.string().max(64).optional(),
  actorUid: z.string().max(128).optional(),
});

export type ChangeSecretCodeInput = z.input<typeof changeSecretCodeSchema>;
export type AdminListUsersInput = z.input<typeof adminListUsersSchema>;
export type AdminUpdateUserStatusInput = z.infer<typeof adminUpdateUserStatusSchema>;
export type AdminInspectConversationInput = z.infer<typeof adminInspectConversationSchema>;
export type AdminListMessagesInput = z.input<typeof adminListMessagesSchema>;
export type AdminListMediaInput = z.input<typeof adminListMediaSchema>;
export type AdminAuditQueryInput = z.input<typeof adminAuditQuerySchema>;

export { searchQuerySchema };

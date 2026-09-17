import { z } from 'zod';
import { SECRET_CODE_MAX_LENGTH } from '@mt/types';

export const startAccessSessionSchema = z.object({
  /** Optional: lets the server bind the challenge to an already signed-in user. */
  language: z.enum(['en', 'bn']).optional(),
});

export const unlockAccessSchema = z.object({
  challengeToken: z.string().min(8),
  /**
   * SHA-256 hex digest of the code the user typed. The plaintext code is never
   * sent back to the server, so it never appears in request logs.
   */
  digest: z.string().regex(/^[a-f0-9]{64}$/, 'digest must be a sha-256 hex digest'),
});

export const lockAccessSchema = z.object({}).passthrough();

export const secretCodeSchema = z
  .string()
  .min(3, 'secret code must be at least 3 characters')
  .max(SECRET_CODE_MAX_LENGTH, `secret code must be at most ${SECRET_CODE_MAX_LENGTH} characters`)
  .refine((value) => !/\s/.test(value), 'secret code must not contain whitespace');

export type StartAccessSessionInput = z.infer<typeof startAccessSessionSchema>;
export type UnlockAccessInput = z.infer<typeof unlockAccessSchema>;
export type SecretCodeInput = z.infer<typeof secretCodeSchema>;

import { z } from 'zod';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USER_NAME_MAX_LENGTH,
  USER_NAME_MIN_LENGTH,
} from '@mt/types';

export const emailSchema = z.email('enter a valid email address').max(254);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, 'password is too long');

export const nameSchema = z
  .string()
  .trim()
  .min(USER_NAME_MIN_LENGTH, `name must be at least ${USER_NAME_MIN_LENGTH} characters`)
  .max(USER_NAME_MAX_LENGTH, 'name is too long');

export const registerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: passwordSchema,
    /** Digest of the secret code, proves the unlock happened in this browser. */
    accessDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'passwords do not match',
    path: ['confirmPassword'],
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  accessDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const reauthenticateSchema = z.object({
  password: passwordSchema,
});

export const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  photoUrl: z.url().max(2048).nullable().optional(),
});

export const passwordResetSchema = z.object({ email: emailSchema });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ReauthenticateInput = z.infer<typeof reauthenticateSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

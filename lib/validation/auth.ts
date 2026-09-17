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

/**
 * The credential forms, validated in the browser before Firebase sees them.
 *
 * A password is deliberately absent from every request body below: Firebase
 * Authentication verifies it in the client SDK, and this API only ever receives
 * the resulting ID token. Storing, forwarding or logging a password is therefore
 * impossible by construction.
 */
export const registerFormSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'passwords do not match',
    path: ['confirmPassword'],
  });

export const loginFormSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const reauthenticateFormSchema = z.object({
  password: passwordSchema,
});

/**
 * `POST /auth/register`. The caller is identified by the Firebase credential it
 * presents, so the body only carries the display name for the new profile and an
 * optional email cross-check.
 */
export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema.optional(),
  /** Digest of the secret code, proves the unlock happened in this browser. */
  accessDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

/** `POST /auth/login`. The email is a cross-check and the rate-limit subject. */
export const loginSchema = z.object({
  email: emailSchema.optional(),
  accessDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

/** `POST /auth/reauthenticate`. The fresh Firebase credential is the whole body. */
export const reauthenticateSchema = z.object({}).passthrough();

export const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  photoUrl: z.url().max(2048).nullable().optional(),
});

export type RegisterFormValues = z.infer<typeof registerFormSchema>;
export type LoginFormValues = z.infer<typeof loginFormSchema>;
export type ReauthenticateFormValues = z.infer<typeof reauthenticateFormSchema>;

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ReauthenticateInput = z.infer<typeof reauthenticateSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

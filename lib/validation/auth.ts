import { z } from 'zod';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USER_NAME_MAX_LENGTH,
  USER_NAME_MIN_LENGTH,
} from '@mt/types';

// Zod's built-in .email() is available on zod strings in v4 via z.email() which
// is what the original code uses; fall back to .string().email() at runtime for safety.
const emailSchema = (z as unknown as { email: (msg: string) => z.ZodString }).email
  ? (z as unknown as { email: (msg: string) => z.ZodString }).email('enter a valid email address').max(254)
  : (z.string().email('enter a valid email address').max(254) as unknown as z.ZodString);

export { emailSchema };

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, 'password is too long');

export const nameSchema = z
  .string()
  .trim()
  .min(USER_NAME_MIN_LENGTH, `name must be at least ${USER_NAME_MIN_LENGTH} characters`)
  .max(USER_NAME_MAX_LENGTH, 'name is too long');

/** Client-side form schemas used by the UI. */
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
 * API schemas. Passwords are sent in the POST body over TLS and verified
 * server-side against an Argon2id hash. The body is never logged and the
 * plaintext password never touches persistent storage.
 */
export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  accessDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  photoUrl: z.string().url().max(2048).nullable().optional(),
});

export type RegisterFormValues = z.infer<typeof registerFormSchema>;
export type LoginFormValues = z.infer<typeof loginFormSchema>;
export type ReauthenticateFormValues = z.infer<typeof reauthenticateFormSchema>;

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ReauthenticateInput = z.infer<typeof reauthenticateSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

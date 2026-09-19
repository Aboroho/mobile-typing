import { z } from 'zod';

/** Blank strings from `.env.example` copies count as unset. */
const optionalNonEmpty = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

/**
 * Only values prefixed with `NEXT_PUBLIC_` are inlined into the browser bundle.
 * This schema is the single place that decides what is public.
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().min(1).default('http://localhost:3000'),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Keypad'),
  NEXT_PUBLIC_WS_URL: optionalNonEmpty,
  NEXT_PUBLIC_ENABLE_TYPING_GAME: booleanish.default(true),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

function getRawPublicEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
    NEXT_PUBLIC_ENABLE_TYPING_GAME: process.env.NEXT_PUBLIC_ENABLE_TYPING_GAME,
  };
}

export function parsePublicEnv(input?: NodeJS.ProcessEnv | Record<string, unknown>): PublicEnv {
  const isDefaultEnv = input === undefined || (typeof process !== 'undefined' && input === process.env);
  const source = isDefaultEnv ? getRawPublicEnv() : input;
  const parsed = publicEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid NEXT_PUBLIC_* environment: ${issues}`);
  }
  return parsed.data;
}

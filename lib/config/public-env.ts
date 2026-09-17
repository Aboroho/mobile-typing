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
 * This schema is the single place that decides what is public, which makes it
 * easy to review: nothing server side may appear here.
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: optionalNonEmpty,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: optionalNonEmpty,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: optionalNonEmpty,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: optionalNonEmpty,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: optionalNonEmpty,
  NEXT_PUBLIC_FIREBASE_APP_ID: optionalNonEmpty,
  NEXT_PUBLIC_APP_URL: z.string().min(1).default('http://localhost:3000'),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Keypad'),
  NEXT_PUBLIC_STUN_URLS: z.string().default(''),
  NEXT_PUBLIC_SENTRY_DSN: optionalNonEmpty,
  /**
   * Toggles the typing-practice game disguise. `true` (default) shows the
   * game first and only reveals chat after the secret code is typed. `false`
   * skips the game/secret-code gate entirely and goes straight to sign-in +
   * chat — useful for environments where the disguise isn't wanted (e.g. a
   * private deployment with its own access control).
   */
  NEXT_PUBLIC_ENABLE_TYPING_GAME: booleanish.default(true),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function parsePublicEnv(env: NodeJS.ProcessEnv = process.env): PublicEnv {
  const parsed = publicEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid NEXT_PUBLIC_* environment: ${issues}`);
  }
  return parsed.data;
}

export function hasFirebaseClientConfig(publicEnv: PublicEnv): boolean {
  return Boolean(publicEnv.NEXT_PUBLIC_FIREBASE_API_KEY);
}

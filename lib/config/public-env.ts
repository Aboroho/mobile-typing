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
  /** Set by next.config.ts from the server's development-only emulator setting. */
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_ENABLED: booleanish.default(false),
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

/**
 * Next.js only inlines literal `process.env.NEXT_PUBLIC_*` property reads.
 * Passing `process.env` itself (or indexing it dynamically) works on the server
 * but produces an empty environment in the browser, even with a complete .env.
 * Keep this explicit allowlist in sync with the schema; never spread server env.
 */
function browserEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_ENABLED:
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_ENABLED,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_STUN_URLS: process.env.NEXT_PUBLIC_STUN_URLS,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_ENABLE_TYPING_GAME: process.env.NEXT_PUBLIC_ENABLE_TYPING_GAME,
  };
}

export function parsePublicEnv(env: Record<string, string | undefined> = browserEnv()): PublicEnv {
  const parsed = publicEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid NEXT_PUBLIC_* environment: ${issues}`);
  }
  return parsed.data;
}

/** The web SDK needs the complete Auth configuration, not just an API key. */
export function hasFirebaseClientConfig(publicEnv: PublicEnv): boolean {
  return Boolean(
    publicEnv.NEXT_PUBLIC_FIREBASE_API_KEY &&
      publicEnv.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN &&
      publicEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
      publicEnv.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID &&
      publicEnv.NEXT_PUBLIC_FIREBASE_APP_ID,
  );
}

/** True when a deployment has started configuring Firebase but is incomplete. */
export function hasPartialFirebaseClientConfig(publicEnv: PublicEnv): boolean {
  const values = [
    publicEnv.NEXT_PUBLIC_FIREBASE_API_KEY,
    publicEnv.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    publicEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    publicEnv.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    publicEnv.NEXT_PUBLIC_FIREBASE_APP_ID,
  ];
  return values.some(Boolean) && !hasFirebaseClientConfig(publicEnv);
}

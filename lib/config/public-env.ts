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
  /** Auth emulator host for local development (e.g. 127.0.0.1:9099). */
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: optionalNonEmpty,
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/**
 * Explicit dictionary of public environment variables.
 * In Next.js (Webpack / Turbopack), `process.env` is NOT a complete dictionary on the client.
 * Bundlers only inline properties that are statically referenced as `process.env.NEXT_PUBLIC_*`.
 */
function getRawPublicEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_STUN_URLS: process.env.NEXT_PUBLIC_STUN_URLS,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_ENABLE_TYPING_GAME: process.env.NEXT_PUBLIC_ENABLE_TYPING_GAME,
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST,
  };
}

export function parsePublicEnv(env?: NodeJS.ProcessEnv | Record<string, unknown>): PublicEnv {
  // When running in the browser, process.env is not a populated dictionary; Next.js only inlines
  // statically referenced process.env.NEXT_PUBLIC_* properties. If env is omitted or is process.env,
  // we build an object with explicit static property accesses so bundlers inline them.
  const isDefaultEnv = env === undefined || (typeof process !== 'undefined' && env === process.env);
  const source = isDefaultEnv ? getRawPublicEnv() : env;
  const parsed = publicEnvSchema.safeParse(source);
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

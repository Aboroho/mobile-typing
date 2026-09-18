import { z } from 'zod';
import { DEFAULT_SECRET_CODE, SECRET_CODE_MAX_LENGTH } from './limits';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

/**
 * Treat blank / whitespace-only env values as unset. Copying `.env.example`
 * leaves keys like `ADMIN_UID=` which would otherwise fail `.min(1).optional()`.
 */
const optionalNonEmpty = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  NEXT_PUBLIC_APP_URL: z.string().default('http://localhost:3000'),

  /**
   * `memory` powers local development and tests, `firestore` is production.
   *
   * There is no equivalent switch for authentication: Firebase Authentication is
   * the only provider, so `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and
   * `FIREBASE_PRIVATE_KEY` are required to sign anybody in.
   */
  DATA_PROVIDER: z.enum(['memory', 'firestore']).default('memory'),
  STORAGE_PROVIDER: z.enum(['memory', 'firebase']).default('memory'),

  /** Explicit opt-in to the local Auth emulator; refused in production. */
  FIREBASE_AUTH_EMULATOR_HOST: optionalNonEmpty,
  FIREBASE_PROJECT_ID: optionalNonEmpty,
  FIREBASE_CLIENT_EMAIL: optionalNonEmpty,
  /** Newlines in the private key arrive escaped from most hosting dashboards. */
  FIREBASE_PRIVATE_KEY: optionalNonEmpty,

  ADMIN_UID: optionalNonEmpty,
  /** Development convenience, resolved server side. Never sent to the client. */
  ADMIN_EMAIL: optionalNonEmpty,

  /** Signs access sessions and challenge tokens. Must be set in production. */
  APP_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),

  SECRET_CODE_MAX_LENGTH: z.coerce.number().int().min(3).max(64).default(SECRET_CODE_MAX_LENGTH),
  /** Bootstrap code used only when no administrator has configured one yet. */
  SEED_SECRET_CODE: z.string().max(SECRET_CODE_MAX_LENGTH).default(DEFAULT_SECRET_CODE),

  STUN_SERVER_URL: z.string().default('stun:stun.l.google.com:19302'),
  TURN_SERVER_URL: optionalNonEmpty,
  TURN_SERVER_USERNAME: optionalNonEmpty,
  TURN_SERVER_CREDENTIAL: optionalNonEmpty,

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  /** `report` avoids breaking third party integrations while tuning the CSP. */
  CSP_MODE: z.enum(['enforce', 'report', 'off']).default('enforce'),
  ENABLE_SECURITY_HEADERS: booleanish.default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  /**
   * Whether the game is disguise is shown at all is not sensitive, so a
   * single `NEXT_PUBLIC_*` flag drives both the client UI and the server-side
   * access-session requirement (see `requireAccess` in `lib/auth/guard.ts`).
   * Keeping one flag avoids the client and API ever disagreeing about whether
   * a secret-code unlock is required.
   */
  NEXT_PUBLIC_ENABLE_TYPING_GAME: booleanish.default(true),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const normalized = {
    ...env,
    FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
  const parsed = serverEnvSchema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export function isProduction(env: Pick<ServerEnv, 'NODE_ENV' | 'APP_ENV'>): boolean {
  return env.NODE_ENV === 'production' && env.APP_ENV === 'production';
}

export function hasFirebaseAdminCredentials(
  env: Pick<ServerEnv, 'FIREBASE_PROJECT_ID' | 'FIREBASE_CLIENT_EMAIL' | 'FIREBASE_PRIVATE_KEY'>,
): boolean {
  return Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Builds the RTCConfiguration ICE servers from environment values. STUN is
 * always included; TURN is only added when all three values are present, since a
 * half configured TURN server makes calls fail in confusing ways.
 */
export function iceServersFromEnv(env: ServerEnv): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: env.STUN_SERVER_URL.split(',').map((u) => u.trim()).filter(Boolean) }];
  if (env.TURN_SERVER_URL && env.TURN_SERVER_USERNAME && env.TURN_SERVER_CREDENTIAL) {
    servers.push({
      urls: env.TURN_SERVER_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: env.TURN_SERVER_USERNAME,
      credential: env.TURN_SERVER_CREDENTIAL,
    });
  }
  return servers;
}

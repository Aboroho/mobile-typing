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
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Development only: extra hostnames the dev server may be reached from, read
   * by `next.config.ts` (see `allowedDevOrigins` there). Local network
   * addresses and `*.local` names are allowed by default, so this is only
   * needed for proxies or public names in front of `npm run dev`. Next.js
   * loads `.env*` before the config file, so the value is visible here.
   */
  ALLOWED_DEV_ORIGINS: optionalNonEmpty,

  /**
   * `memory` powers local development and tests without a database, `prisma` is
   * the production Postgres backend.
   */
  DATA_PROVIDER: z.enum(['memory', 'prisma']).default('memory'),
  /**
   * `memory` stores uploads on the local filesystem (dev only), `local` writes
   * to a configurable directory on disk, `s3` talks to any S3-compatible object
   * store (AWS, MinIO, Cloudflare R2, etc.).
   */
  STORAGE_PROVIDER: z.enum(['memory', 'local', 's3']).default('memory'),

  // --- Postgres / Prisma ---------------------------------------------------
  DATABASE_URL: z.string().default('postgresql://localhost:5432/mobile_typing?schema=public'),

  // --- Session / auth -------------------------------------------------------
  /** Signs session cookies, access sessions and challenge tokens. Must be set in production. */
  APP_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me-please-32-bytes'),
  SESSION_COOKIE_NAME: z.string().default('mt_session'),
  SESSION_DURATION_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 14), // two weeks

  // --- Admin ---------------------------------------------------------------
  ADMIN_UID: optionalNonEmpty,
  /** Development convenience, resolved server side. Never sent to the client. */
  ADMIN_EMAIL: optionalNonEmpty,

  // --- Secret code ---------------------------------------------------------
  SECRET_CODE_MAX_LENGTH: z.coerce.number().int().min(3).max(64).default(SECRET_CODE_MAX_LENGTH),
  /** Bootstrap code used only when no administrator has configured one yet. */
  SEED_SECRET_CODE: z.string().max(SECRET_CODE_MAX_LENGTH).default(DEFAULT_SECRET_CODE),

  // --- WebRTC --------------------------------------------------------------
  STUN_SERVER_URL: z.string().default('stun:stun.l.google.com:19302'),
  TURN_SERVER_URL: optionalNonEmpty,
  TURN_SERVER_USERNAME: optionalNonEmpty,
  TURN_SERVER_CREDENTIAL: optionalNonEmpty,

  // --- Object storage ------------------------------------------------------
  /** S3-compatible endpoint. Leave blank for real AWS S3. */
  STORAGE_ENDPOINT: optionalNonEmpty,
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('keypad-media'),
  STORAGE_ACCESS_KEY: optionalNonEmpty,
  STORAGE_SECRET_KEY: optionalNonEmpty,
  /** Force path-style URLs (required by MinIO, most local dev setups). */
  STORAGE_FORCE_PATH_STYLE: booleanish.default(false),
  /** For STORAGE_PROVIDER=local: directory on disk where files are written. */
  STORAGE_LOCAL_DIR: z.string().default('./.local-storage'),
  /** Max upload size in bytes (default 25 MiB). */
  STORAGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  /** How long signed upload/download URLs are valid, in seconds. */
  STORAGE_SIGN_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // --- Media / upload limits ----------------------------------------------
  MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  MAX_VOICE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(4000),

  // --- Rate limiting ------------------------------------------------------
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // --- Outbox worker ------------------------------------------------------
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(100),

  // --- Security / logging -------------------------------------------------
  /** `report` avoids breaking third party integrations while tuning the CSP. */
  CSP_MODE: z.enum(['enforce', 'report', 'off']).default('enforce'),
  ENABLE_SECURITY_HEADERS: booleanish.default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  /**
   * Whether the typing-game disguise is shown at all is not sensitive, so a
   * single `NEXT_PUBLIC_*` flag drives both the client UI and the server-side
   * access-session requirement (see `requireAccess` in `lib/auth/guard.ts`).
   * Keeping one flag avoids the client and API ever disagreeing about whether
   * a secret-code unlock is required.
   */
  NEXT_PUBLIC_ENABLE_TYPING_GAME: booleanish.default(true),

  // --- WebSocket -----------------------------------------------------------
  /** Public URL the browser uses to open the WS connection. */
  NEXT_PUBLIC_WS_URL: optionalNonEmpty,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(input: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export function isProduction(env: Pick<ServerEnv, 'NODE_ENV' | 'APP_ENV'>): boolean {
  return env.NODE_ENV === 'production' && env.APP_ENV === 'production';
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
  const servers: IceServerConfig[] = [
    {
      urls: env.STUN_SERVER_URL.split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    },
  ];
  if (env.TURN_SERVER_URL && env.TURN_SERVER_USERNAME && env.TURN_SERVER_CREDENTIAL) {
    servers.push({
      urls: env.TURN_SERVER_URL.split(',')
        .map((u) => u.trim())
        .filter(Boolean),
      username: env.TURN_SERVER_USERNAME,
      credential: env.TURN_SERVER_CREDENTIAL,
    });
  }
  return servers;
}

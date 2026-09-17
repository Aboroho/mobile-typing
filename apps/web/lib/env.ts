import { parseServerEnv, type ServerEnv } from '@mt/config';

let cached: ServerEnv | null = null;

/** Parsed, validated server environment. Throws early when misconfigured. */
export function env(): ServerEnv {
  if (!cached) cached = parseServerEnv(process.env);
  return cached;
}

/** Test helper: re-read process.env (used after a test mutates it). */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  const e = env();
  return e.NODE_ENV === 'production' && e.APP_ENV === 'production';
}

/**
 * Development-only fallbacks (in-memory data, dev auth) must never be reachable
 * from a production deployment. Every fallback provider calls this.
 */
export function assertFallbackAllowed(provider: string): void {
  if (isProduction()) {
    throw new Error(
      `Refusing to use the ${provider} fallback in production. Configure Firebase ` +
        '(DATA_PROVIDER=firestore, AUTH_PROVIDER=firebase, STORAGE_PROVIDER=firebase).',
    );
  }
}

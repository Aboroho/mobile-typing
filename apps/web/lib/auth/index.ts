import { assertFallbackAllowed, env } from '../env';
import { logger } from '../logger';
import { createDevAuthProvider } from './dev';
import { createFirebaseAuthProvider } from './firebase';
import type { AuthProvider } from './types';

export * from './types';
export { hashPassword, verifyPassword } from './password';
export { issueDevSessionToken } from './dev';

let cached: AuthProvider | null = null;
let cachedName: string | null = null;

export function getAuthProvider(): AuthProvider {
  const configured = env().AUTH_PROVIDER;
  if (cached && cachedName === configured) return cached;
  cached = configured === 'firebase' ? createFirebaseAuthProvider() : createDevAuthProvider();
  if (configured !== 'firebase') assertFallbackAllowed('dev authentication');
  cachedName = configured;
  logger.info('auth.provider.selected', { provider: cached.name });
  return cached;
}

export function resetAuthProvider(): void {
  cached = null;
  cachedName = null;
}

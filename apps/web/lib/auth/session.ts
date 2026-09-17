import { AppError } from '@mt/domain';
import { ApiErrorCode } from '@mt/types';
import { env } from '../env';
import { getData } from '../data';
import { logger } from '../logger';
import { getAuthProvider } from './index';
import { readCookie } from './cookies';
import { SESSION_COOKIE, type ResolvedAuth, type VerifiedToken } from './types';

/** Extracts the bearer token, falling back to the dev session cookie. */
export function extractToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
  return readCookie(request, SESSION_COOKIE);
}

export async function verifyRequestToken(request: Request): Promise<VerifiedToken | null> {
  const token = extractToken(request);
  if (!token) return null;
  return getAuthProvider().verifyToken(token);
}

/**
 * Resolves the caller: token → uid → user record → status check. Returns null
 * when unauthenticated, and throws ACCOUNT_DISABLED for a deactivated account so
 * a disabled user is stopped even with a still-valid token.
 */
export async function resolveAuth(request: Request): Promise<ResolvedAuth | null> {
  const verified = await verifyRequestToken(request);
  if (!verified) return null;
  const data = await getData();
  const user = await data.users.getById(verified.uid);
  if (!user) return null;
  if (user.status === 'disabled') {
    logger.warn('auth.disabled_account_attempt', { uid: user.id });
    throw new AppError(ApiErrorCode.ACCOUNT_DISABLED, 'this account has been disabled');
  }
  if (user.status === 'deleted') throw AppError.unauthenticated();
  return { user, token: verified };
}

/**
 * Administrator identity comes from the environment only. `ADMIN_UID` is the
 * canonical setting; `ADMIN_EMAIL` is a convenience for local development where
 * the generated uid is not known in advance. Neither is ever sent to a client.
 */
export function isAdminUser(user: { id: string; email: string }): boolean {
  const { ADMIN_UID, ADMIN_EMAIL } = env();
  if (ADMIN_UID && user.id === ADMIN_UID) return true;
  if (ADMIN_EMAIL && user.email.toLowerCase() === ADMIN_EMAIL.trim().toLowerCase()) return true;
  return false;
}

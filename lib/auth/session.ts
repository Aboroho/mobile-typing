import { AppError } from '@mt/domain';
import { ApiErrorCode } from '@mt/types';
import { env } from '../env';
import { getData } from '../data';
import { logger } from '../logger';
import { readCookie } from './cookies';
import { verifyFirebaseIdToken, verifyFirebaseSessionCookie } from './firebase';
import { SESSION_COOKIE, type CredentialSource, type ResolvedAuth, type VerifiedToken } from './types';

/** The credential a request presented, before it has been verified. */
export interface RequestCredential {
  value: string;
  source: CredentialSource;
}

/**
 * Extracts the Firebase credential: a bearer ID token when the browser SDK has
 * one, otherwise the httpOnly session cookie this API minted.
 *
 * The bearer wins because it is the freshest statement of who the caller is;
 * the cookie is what an `EventSource` (SSE) request can send, since it cannot
 * set headers.
 */
export function extractCredential(request: Request): RequestCredential | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    if (value) return { value, source: 'id-token' };
  }
  const cookie = readCookie(request, SESSION_COOKIE);
  return cookie ? { value: cookie, source: 'session-cookie' } : null;
}

/** Verifies whatever credential the request carries. `null` = unauthenticated. */
export async function verifyRequestToken(request: Request): Promise<VerifiedToken | null> {
  const credential = extractCredential(request);
  if (!credential) return null;
  return credential.source === 'id-token'
    ? verifyFirebaseIdToken(credential.value)
    : verifyFirebaseSessionCookie(credential.value);
}

/**
 * Resolves the caller: credential → Firebase uid → application profile → status
 * check. Returns null when unauthenticated, and throws ACCOUNT_DISABLED for a
 * deactivated account so a disabled user is stopped even with a still-valid
 * credential.
 *
 * The uid comes from the verified Firebase credential only. Nothing in this
 * chain reads a user id, a role or an email address from the request body or
 * query string, so a client cannot claim to be somebody else.
 */
export async function resolveAuth(request: Request): Promise<ResolvedAuth | null> {
  const verified = await verifyRequestToken(request);
  if (!verified) return null;
  const data = await getData();
  const user = await data.users.getById(verified.uid);
  if (!user) {
    // A Firebase account with no application profile: the caller is who they say
    // they are, but there is nothing to authorise yet. `/auth/register` and the
    // client's profile recovery create it.
    logger.info('auth.profile_missing', { uid: verified.uid });
    return null;
  }
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
 * the generated uid is not known in advance. Neither is ever sent to a client,
 * and no custom claim or request field can confer the role.
 */
export function isAdminUser(user: { id: string; email: string }): boolean {
  const { ADMIN_UID, ADMIN_EMAIL } = env();
  if (ADMIN_UID && user.id === ADMIN_UID) return true;
  if (ADMIN_EMAIL && user.email.toLowerCase() === ADMIN_EMAIL.trim().toLowerCase()) return true;
  return false;
}

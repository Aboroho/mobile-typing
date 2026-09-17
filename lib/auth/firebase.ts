import type { DecodedIdToken } from 'firebase-admin/auth';
import { AppError } from '@mt/domain';
import { AUTH_SESSION_TTL_MS, FRESH_CREDENTIAL_MAX_AGE_MS } from '@mt/types';
import { getAdminAuth } from '../firebase/admin';
import { getData } from '../data';
import { logger } from '../logger';
import type { CredentialSource, VerifiedToken } from './types';

/**
 * The single trusted boundary with Firebase Authentication.
 *
 * Passwords are verified by Firebase in the browser (`signInWithEmailAndPassword`
 * / `createUserWithEmailAndPassword`); this module only ever sees the resulting
 * ID token, and everything it returns has been checked against the Admin SDK —
 * signature, audience, expiry and (with `checkRevoked`) revocation.
 *
 * Two credentials are accepted, both issued by Firebase:
 *  - the short lived **ID token** the browser SDK holds, sent as a bearer token;
 *  - the long lived **session cookie** this API mints from a fresh ID token,
 *    which is what makes cookie-only requests (SSE streams) work.
 */

function toVerifiedToken(decoded: DecodedIdToken, source: CredentialSource): VerifiedToken {
  const displayName = typeof decoded.name === 'string' && decoded.name.trim() ? decoded.name.trim() : null;
  return {
    uid: decoded.uid,
    email: decoded.email ?? '',
    displayName,
    authTime: decoded.auth_time ?? Math.floor(Date.now() / 1000),
    isAdminClaim: decoded.role === 'admin' || decoded.admin === true,
    source,
  };
}

/**
 * Never log the credential or the SDK error verbatim: Firebase errors can carry
 * request details. The event name still tells an operator whether the project,
 * the audience, the expiry or the Admin configuration is wrong.
 */
function logVerificationFailure(kind: 'id_token' | 'session_cookie', error: unknown): void {
  logger.warn('auth.firebase_credential_rejected', {
    kind,
    reason: error instanceof Error ? error.name : 'unknown_error',
  });
}

/** Verifies a Firebase ID token. `null` means "not authenticated". */
export async function verifyFirebaseIdToken(token: string): Promise<VerifiedToken | null> {
  try {
    // checkRevoked: a token issued before a password change, an administrator's
    // revocation or a logout must stop working immediately, not an hour later.
    return toVerifiedToken(await getAdminAuth().verifyIdToken(token, true), 'id-token');
  } catch (error) {
    logVerificationFailure('id_token', error);
    return null;
  }
}

/** Verifies the `mt_session` cookie (a Firebase session cookie). */
export async function verifyFirebaseSessionCookie(cookie: string): Promise<VerifiedToken | null> {
  try {
    return toVerifiedToken(await getAdminAuth().verifySessionCookie(cookie, true), 'session-cookie');
  } catch (error) {
    logVerificationFailure('session_cookie', error);
    return null;
  }
}

/**
 * Whether the credential was presented recently enough to be upgraded into a
 * session cookie. Firebase's session-cookie guide requires this: without it a
 * single leaked (already old) ID token would buy a week-long session.
 */
export function isFreshCredential(verified: VerifiedToken, now: number = Date.now()): boolean {
  return now - verified.authTime * 1000 <= FRESH_CREDENTIAL_MAX_AGE_MS;
}

/**
 * Exchanges a freshly issued Firebase ID token for a session cookie value.
 *
 * Throws `PRECONDITION_FAILED` when the credential is valid but too old, which
 * is the signal for the browser to ask for the password again. Any other Admin
 * SDK failure becomes an opaque 500: the cause is logged, never returned.
 */
export async function createFirebaseSessionCookie(idToken: string, verified: VerifiedToken): Promise<string> {
  if (!isFreshCredential(verified)) {
    logger.info('auth.session_cookie_refused_stale_credential', { uid: verified.uid });
    throw AppError.precondition('sign in again to continue');
  }
  try {
    return await getAdminAuth().createSessionCookie(idToken, { expiresIn: AUTH_SESSION_TTL_MS });
  } catch (error) {
    logger.error('auth.session_cookie_failed', {
      uid: verified.uid,
      reason: error instanceof Error ? error.name : 'unknown_error',
    });
    throw AppError.internal(error);
  }
}

/**
 * Invalidates every Firebase credential of a user: ID tokens, session cookies
 * and refresh tokens. Used by logout and by an administrator disabling an
 * account, so a cleared cookie cannot be replayed and a disabled account cannot
 * keep an existing session alive.
 *
 * Best effort by design — callers still clear the cookie and update the profile.
 */
export async function revokeFirebaseSessions(uid: string): Promise<boolean> {
  try {
    await getAdminAuth().revokeRefreshTokens(uid);
    return true;
  } catch (error) {
    logger.warn('auth.firebase_revocation_failed', {
      uid,
      reason: error instanceof Error ? error.name : 'unknown_error',
    });
    return false;
  }
}

/**
 * Enables or disables the Firebase account behind a profile.
 *
 * The application profile's `status` is the authoritative gate for this API (see
 * `resolveAuth`), so a profile whose Firebase account no longer exists — one
 * created before Authentication was in front of the app — must not make an
 * administrator's status change fail. That case is reported and skipped.
 */
export async function setFirebaseUserDisabled(uid: string, disabled: boolean): Promise<void> {
  const auth = getAdminAuth();
  try {
    await auth.updateUser(uid, { disabled });
    if (disabled) await auth.revokeRefreshTokens(uid).catch(() => undefined);
  } catch (error) {
    const code = (error as { errorInfo?: { code?: string } })?.errorInfo?.code ?? '';
    if (code === 'auth/user-not-found') {
      logger.warn('auth.firebase_account_absent', { uid });
      return;
    }
    logger.error('auth.firebase_disable_failed', { uid, reason: error instanceof Error ? error.name : 'unknown_error' });
    throw AppError.internal(error);
  }
  const data = await getData();
  await data.users.update(uid, { status: disabled ? 'disabled' : 'active' });
}

import { AppError, isAppError, sanitizeName } from '@mt/domain';
import { ApiErrorCode } from '@mt/types';
import { nowIso } from '@mt/utils';
import { getData, type UserRecord } from '../data';
import { revokeFirebaseSessions } from '../auth/firebase';
import { establishSession, type CookieInstruction, type EstablishedSession } from '../auth/session-cookies';
import { isAdminUser, verifyRequestToken } from '../auth/session';
import type { VerifiedToken } from '../auth/types';
import { firebaseClientConfigured } from '../diagnostics';
import { logger } from '../logger';

export interface AuthOutcome {
  user: UserRecord;
  /**
   * Always `null`. The Firebase ID token belongs to the browser SDK, which
   * attaches it to API calls itself; this API never hands a credential back.
   */
  token: null;
  /** The session lives in the httpOnly `mt_session` cookie. */
  cookieSession: boolean;
  /** The session cookie to set, when a fresh credential allowed one to be minted. */
  session: CookieInstruction | null;
}

/**
 * Explains, in the server log, the one misconfiguration that makes every
 * sign-up and sign-in fail with a bare 401: the browser has no Firebase app to
 * authenticate against, so no ID token ever reaches this API.
 *
 * A 401 is the correct answer to an unauthenticated caller and it is not safe to
 * explain a deployment's configuration to an anonymous client, so the cause is
 * written where the operator will find it — naming the variables, never their
 * values.
 */
function reportUnverifiableCredential(route: string): void {
  if (!firebaseClientConfigured()) {
    logger.error('auth.firebase_client_config_missing', {
      route,
      detail:
        'The browser cannot obtain a Firebase ID token because the Firebase web configuration is incomplete: ' +
        'NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID, ' +
        'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID and NEXT_PUBLIC_FIREBASE_APP_ID must all be set. ' +
        'Until they are, registration and login can never authenticate.',
    });
    return;
  }
  logger.warn('auth.credential_rejected', { route });
}

/** Verifies the caller's Firebase credential, with the operator diagnostic above. */
async function authenticate(
  request: Request,
  route: string,
  options: { failureMessage: string; requireFresh?: boolean },
): Promise<EstablishedSession> {
  try {
    return await establishSession(request, options);
  } catch (error) {
    if (isAppError(error) && error.code === ApiErrorCode.UNAUTHENTICATED) {
      reportUnverifiableCredential(route);
    }
    throw error;
  }
}

/**
 * Registration.
 *
 * The browser has already created the Firebase account with
 * `createUserWithEmailAndPassword`, set its display name and obtained an ID
 * token; this call turns that verified identity into an application profile and
 * a session. Passwords never reach the API, and the uid is taken from the
 * verified credential — never from the request body.
 *
 * It is idempotent for the authenticated identity, which is what makes a retry
 * after a transient profile-write failure safe.
 */
export async function register(input: {
  name: string;
  email?: string;
  request: Request;
}): Promise<AuthOutcome> {
  const { verified, cookie } = await authenticate(input.request, 'register', {
    failureMessage: 'complete the Firebase sign-up first',
  });
  const data = await getData();
  const name = sanitizeName(input.name);
  const email = requireEmail(verified);

  if (conflictingEmail(input.email, email)) {
    logger.warn('auth.register_email_mismatch', { uid: verified.uid });
    throw AppError.conflict('that account cannot be linked to this profile');
  }

  const existing = await data.users.getById(verified.uid);
  if (existing) {
    if (existing.email.trim().toLowerCase() !== email) {
      logger.warn('auth.firebase_profile_email_mismatch', { uid: verified.uid });
      throw AppError.conflict('that account cannot be linked to this profile');
    }
    return outcome(existing, cookie);
  }

  // Do not associate a new Firebase uid with an application profile that belongs
  // to another uid, even when the email is duplicated or stale in the request:
  // that profile's conversations and messages belong to somebody else.
  const emailOwner = await data.users.getByEmail(email);
  if (emailOwner) {
    logger.warn('auth.register_email_taken_by_other_uid', { uid: verified.uid, ownerId: emailOwner.id });
    throw AppError.conflict('unable to create that account');
  }

  const record = await createProfile({ id: verified.uid, email, name });
  return outcome(record, cookie);
}

/**
 * Login.
 *
 * The password was checked by Firebase in the browser; here the verified
 * credential becomes a session plus the caller's existing application profile.
 * A missing profile is recovered instead of failing, so an account whose profile
 * document was lost can still sign in.
 */
export async function login(input: { email?: string; request: Request }): Promise<AuthOutcome> {
  const { verified, cookie } = await authenticate(input.request, 'login', {
    // One opaque message for every failure mode: a wrong password, an unknown
    // email and a disabled account must be indistinguishable from the outside.
    failureMessage: 'unable to sign in with those details',
  });
  const data = await getData();
  const email = requireEmail(verified);

  if (conflictingEmail(input.email, email)) {
    logger.warn('auth.login_email_mismatch', { uid: verified.uid });
    throw AppError.unauthenticated('unable to sign in with those details');
  }

  const record = await ensureProfile(verified, email);
  if (record.status === 'disabled') {
    logger.warn('auth.login_disabled', { uid: record.id });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  await data.users.touchLogin(record.id, nowIso());
  return outcome(record, cookie);
}

/**
 * Password gate for an already signed-in user (the third access-flow branch).
 *
 * The browser re-authenticated with `reauthenticateWithCredential`, which resets
 * Firebase's `auth_time`; `requireFresh` is what proves that happened. Without a
 * recent credential the gate would be a no-op, so it is refused rather than
 * accepted.
 */
export async function reauthenticate(input: { request: Request }): Promise<AuthOutcome> {
  const { verified, cookie } = await authenticate(input.request, 'reauthenticate', {
    failureMessage: 'sign in again to continue',
    requireFresh: true,
  });
  const record = await ensureProfile(verified, requireEmail(verified));
  return outcome(record, cookie);
}

/**
 * Logout.
 *
 * Revokes the caller's Firebase credentials server side (ID tokens, session
 * cookies and refresh tokens), so a cookie that was copied before logout cannot
 * be replayed afterwards. It must also succeed for a caller who is already
 * signed out: clearing the cookies is the part the browser depends on.
 */
export async function logout(request: Request): Promise<{ revoked: boolean }> {
  const verified = await verifyRequestToken(request);
  if (!verified) return { revoked: false };
  const revoked = await revokeFirebaseSessions(verified.uid);
  logger.info('auth.logout', { uid: verified.uid, revoked });
  return { revoked };
}

function outcome(user: UserRecord, session: CookieInstruction | null): AuthOutcome {
  return { user, token: null, cookieSession: true, session };
}

function requireEmail(verified: VerifiedToken): string {
  const email = verified.email.trim().toLowerCase();
  if (!email) {
    logger.warn('auth.firebase_token_missing_email', { uid: verified.uid });
    throw AppError.unauthenticated('your Firebase account does not have an email address');
  }
  return email;
}

/** The email in the body is a cross-check only; the credential decides. */
function conflictingEmail(submitted: string | undefined, verifiedEmail: string): boolean {
  const normalized = submitted?.trim().toLowerCase();
  return Boolean(normalized) && normalized !== verifiedEmail;
}

/** Loads the caller's profile, creating it when Firebase knows them but we do not. */
async function ensureProfile(verified: VerifiedToken, email: string): Promise<UserRecord> {
  const data = await getData();
  const existing = await data.users.getById(verified.uid);
  if (existing) return existing;
  const fallbackName = verified.displayName ?? email.split('@')[0] ?? 'User';
  logger.warn('auth.profile_recreated', { uid: verified.uid });
  return createProfile({ id: verified.uid, email, name: fallbackName });
}

/**
 * Creates the application profile for a verified Firebase identity.
 *
 * The Firebase uid *is* the application user id, which is what conversations,
 * messages, media and calls already reference. No password material is stored:
 * Firebase Authentication owns the credential.
 */
async function createProfile(input: { id: string; email: string; name: string }): Promise<UserRecord> {
  const data = await getData();
  const now = nowIso();
  const record: UserRecord = {
    id: input.id,
    name: sanitizeName(input.name),
    email: input.email.trim().toLowerCase(),
    photoUrl: null,
    status: 'active',
    lastLoginAt: now,
    isAdmin: false,
    createdAt: now,
    updatedAt: now,
    disabledReason: null,
  };
  // Derived from the server environment, so a public registration can never
  // grant itself the administrator role.
  record.isAdmin = isAdminUser(record);
  await data.users.create(record);
  logger.info('auth.profile_created', { uid: record.id });
  return record;
}

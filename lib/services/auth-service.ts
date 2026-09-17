import { AppError, sanitizeName } from '@mt/domain';
import { nowIso } from '@mt/utils';
import { getData, type UserRecord } from '../data';
import { getAuthProvider, issueDevSessionToken } from '../auth';
import { hashPassword } from '../auth/password';
import { isAdminUser, verifyRequestToken } from '../auth/session';
import { firebaseClientConfigured } from '../diagnostics';
import { logger } from '../logger';

export interface AuthOutcome {
  user: UserRecord;
  token: string | null;
  cookieSession: boolean;
}

/**
 * With `AUTH_PROVIDER=firebase` the API only accepts ID tokens that the browser
 * obtained from the Firebase SDK. When the public Firebase config is unset the
 * client silently uses the dev adapter instead (see lib/client/auth-client.ts),
 * so no token ever arrives and every sign-up / sign-in is rejected. The 401 the
 * caller receives is correct but meaningless to them, and it is not safe to
 * explain a deployment's configuration to an anonymous client — so the real
 * cause is written to the server log, where the operator will find it.
 */
function logMissingFirebaseClientConfig(route: string): void {
  if (firebaseClientConfigured()) return;
  logger.error('auth.firebase_client_config_missing', {
    route,
    detail:
      'AUTH_PROVIDER=firebase but NEXT_PUBLIC_FIREBASE_* is unset, so the browser cannot obtain a Firebase ID ' +
      'token and this request can never authenticate. Fill in the Firebase web config, or use AUTH_PROVIDER=dev ' +
      'for local development.',
  });
}

/**
 * Two authentication shapes are supported by the same endpoints:
 *
 *  1. Firebase (production): the client authenticates with the Firebase SDK and
 *     presents the resulting ID token. Passwords never reach this API.
 *  2. Dev (local development / tests): the client posts email + password and the
 *     server issues a signed session token, so the whole product can run without
 *     a Firebase project.
 */
export async function register(input: {
  name: string;
  email?: string;
  password?: string;
  request: Request;
}): Promise<AuthOutcome> {
  const provider = getAuthProvider();
  const data = await getData();
  const name = sanitizeName(input.name);

  if (provider.name === 'firebase') {
    const verified = await verifyRequestToken(input.request);
    if (!verified) {
      logMissingFirebaseClientConfig('register');
      throw AppError.unauthenticated('complete the Firebase sign-up first');
    }
    const normalizedEmail = verified.email.trim().toLowerCase();
    if (!normalizedEmail) {
      logger.warn('auth.firebase_token_missing_email', { uid: verified.uid });
      throw AppError.unauthenticated('your Firebase account does not have an email address');
    }

    // Registration is intentionally idempotent for the authenticated Firebase
    // identity. This is what makes a retry after a transient profile-write
    // failure safe, while the email check prevents an inconsistent identity
    // association if a Firebase account's email was changed later.
    const existing = await data.users.getById(verified.uid);
    if (existing) {
      if (existing.email.trim().toLowerCase() !== normalizedEmail) {
        logger.warn('auth.firebase_profile_email_mismatch', { uid: verified.uid });
        throw AppError.conflict('that account cannot be linked to this profile');
      }
      return { user: existing, token: null, cookieSession: false };
    }

    // Do not associate a new Firebase UID with an application profile that
    // belongs to another UID, even when the Firebase email is duplicated or
    // stale in the request.
    const emailOwner = await data.users.getByEmail(normalizedEmail);
    if (emailOwner) throw AppError.conflict('that account already exists');

    const record = await createProfile({
      id: verified.uid,
      email: normalizedEmail,
      name,
    });
    return { user: record, token: null, cookieSession: false };
  }

  if (!input.email || !input.password) {
    throw new AppError('BAD_REQUEST', 'email and password are required');
  }
  await provider.createUser({ email: input.email, password: input.password, name });
  const record = await data.users.getByEmail(input.email);
  if (!record) throw AppError.internal();
  const { token } = await issueDevSessionToken({
    uid: record.id,
    email: record.email,
    authTime: Math.floor(Date.now() / 1000),
  });
  return { user: record, token, cookieSession: true };
}

export async function login(input: {
  email?: string;
  password?: string;
  request: Request;
}): Promise<AuthOutcome> {
  const provider = getAuthProvider();
  const data = await getData();

  if (provider.name === 'firebase') {
    const verified = await verifyRequestToken(input.request);
    if (!verified) {
      logMissingFirebaseClientConfig('login');
      throw AppError.unauthenticated('invalid credentials');
    }
    let record = await data.users.getById(verified.uid);
    if (!record) {
      record = await createProfile({ id: verified.uid, email: verified.email, name: verified.email.split('@')[0] ?? 'User' });
    }
    if (record.status === 'disabled') {
      // Indistinguishable from bad credentials: revealing that an account exists
      // and is disabled is an enumeration channel.
      logger.warn('auth.login_disabled', { uid: record.id });
      throw AppError.unauthenticated('unable to sign in with those details');
    }
    await data.users.touchLogin(record.id, nowIso());
    return { user: record, token: null, cookieSession: false };
  }

  if (!input.email || !input.password) {
    throw new AppError('BAD_REQUEST', 'email and password are required');
  }
  const verified = await provider.verifyPassword(input.email, input.password);
  // One opaque message for every failure mode: a wrong password and an unknown
  // email must be indistinguishable from the outside.
  if (!verified) throw AppError.unauthenticated('unable to sign in with those details');
  if (verified.disabled) {
    logger.warn('auth.login_disabled', { uid: verified.uid });
    throw AppError.unauthenticated('unable to sign in with those details');
  }

  const record = await data.users.getById(verified.uid);
  if (!record) throw AppError.internal();
  await data.users.touchLogin(record.id, nowIso());
  const { token } = await issueDevSessionToken({
    uid: record.id,
    email: record.email,
    authTime: Math.floor(Date.now() / 1000),
  });
  return { user: record, token, cookieSession: true };
}

const REAUTH_MAX_AGE_MS = 5 * 60 * 1000;

export async function reauthenticate(input: {
  password?: string;
  request: Request;
}): Promise<AuthOutcome> {
  const provider = getAuthProvider();
  const data = await getData();

  if (provider.name === 'firebase') {
    const verified = await verifyRequestToken(input.request);
    if (!verified) {
      logMissingFirebaseClientConfig('reauthenticate');
      throw AppError.unauthenticated('sign in again to continue');
    }
    const ageMs = Date.now() - verified.authTime * 1000;
    if (ageMs > REAUTH_MAX_AGE_MS) {
      throw AppError.precondition('re-enter your password to continue');
    }
    const record = await data.users.getById(verified.uid);
    if (!record) throw AppError.notFound('user not found');
    return { user: record, token: null, cookieSession: false };
  }

  const current = await verifyRequestToken(input.request);
  if (!current) throw AppError.unauthenticated();
  if (!input.password) throw new AppError('BAD_REQUEST', 'password is required');
  const record = await data.users.getById(current.uid);
  if (!record) throw AppError.unauthenticated();
  const verified = await provider.verifyPassword(record.email, input.password);
  if (!verified) throw AppError.unauthenticated('that password is not correct');
  const { token } = await issueDevSessionToken({
    uid: record.id,
    email: record.email,
    authTime: Math.floor(Date.now() / 1000),
  });
  return { user: record, token, cookieSession: true };
}

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
    passwordHash: null,
    passwordSalt: null,
    disabledReason: null,
  };
  record.isAdmin = isAdminUser(record);
  await data.users.create(record);
  logger.info('auth.profile_created', { uid: record.id });
  return record;
}

/** Dev only: rotate the stored password after a reset. */
export async function setPassword(userId: string, password: string): Promise<void> {
  const data = await getData();
  const { hash, salt } = hashPassword(password);
  await data.users.updatePassword(userId, hash, salt);
}

import { AppError, sanitizeName } from '@mt/domain';
import { nowIso, newUid } from '@mt/utils';
import { getData, type UserRecord } from '../data';
import { isUniqueConstraintError } from '../data/types';
import { hashPassword, verifyPassword } from '../auth/password';
import { createSession, clearSessionCookie, verifySession, revokeAllSessionsForUser, isAdminUser, type CookieInstruction } from '../auth/session';
import { logger } from '../logger';

export interface AuthOutcome {
  user: UserRecord;
  token: null;
  cookieSession: boolean;
  session: CookieInstruction | null;
  /**
   * `true` when the account was created by this request, `false` when the
   * caller submitted credentials for an account that already existed (a
   * duplicate submit or a browser retry). The route maps this onto 201 vs 200
   * so a client can tell "created" from "already yours" — both are success.
   */
  created: boolean;
}

/** Helper for rate-limit subject key. */
export function authKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Verify current session, if any. Used by /auth/me. */
export async function getMe(request: Request): Promise<UserRecord | null> {
  const verified = await verifySession(request);
  if (!verified) return null;
  const data = await getData();
  return data.users.getById(verified.uid);
}

/**
 * Registration.
 *
 * Contract:
 *  - a new email creates exactly one account and issues a fresh session cookie;
 *  - a repeat submit for an existing email with the *correct* password is
 *    idempotent — it re-issues a session instead of failing. This is what makes
 *    a double-clicked button, a browser retry or a client bug harmless rather
 *    than a false "cannot create account" error on an account that exists;
 *  - a repeat submit with the *wrong* password is rejected with the same
 *    generic 401 used by login, so accounts cannot be enumerated;
 *  - two concurrent submits of the same email cannot create two accounts: the
 *    loser of the unique-constraint race re-reads the row and signs in.
 */
export async function register(input: {
  name: string;
  email: string;
  password: string;
  request: Request;
}): Promise<AuthOutcome> {
  const email = input.email.trim().toLowerCase();
  const data = await getData();

  const existing = await data.users.getByEmail(email);
  if (existing) {
    const outcome = await sessionForExistingAccount(existing, input.password, 'email_taken', input.request);
    return { ...outcome, created: false };
  }

  const passwordHash = await hashPassword(input.password);
  const now = nowIso();
  const id = newUid();
  const record: UserRecord = {
    id,
    name: sanitizeName(input.name),
    email,
    photoUrl: null,
    status: 'active',
    lastLoginAt: now,
    isAdmin: isAdminUser({ id, email }),
    createdAt: now,
    updatedAt: now,
    disabledReason: null,
  };

  try {
    // One write for the row and its hash column — no half-created account.
    const created = await data.users.createWithPasswordHash(record, passwordHash);
    logger.info('auth.profile_created', { uid: created.id });
    return { ...(await loginForUser(created, input.request)), created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Lost a race with a concurrent submit of the same email. The other
    // request already committed the account, so treat this one as a login.
    const winner = await data.users.getByEmail(email);
    if (!winner) throw error;
    logger.warn('auth.register_race_recovered', { uid: winner.id });
    const outcome = await sessionForExistingAccount(winner, input.password, 'race', input.request);
    return { ...outcome, created: false };
  }
}

/**
 * Login: email + password verified against the stored Argon2 hash. A fresh
 * session is issued on success; disabled accounts are rejected with the same
 * generic error used for invalid credentials.
 */
export async function login(input: {
  email: string;
  password: string;
  request: Request;
}): Promise<AuthOutcome> {
  const email = input.email.trim().toLowerCase();
  const data = await getData();
  const record = await data.users.getByEmail(email);
  if (!record) {
    logger.warn('auth.login_unknown_email', { email });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  if (record.status === 'disabled') {
    logger.warn('auth.login_disabled', { uid: record.id });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  const hash = await data.users.getPasswordHash(record.id);
  if (!hash) {
    logger.warn('auth.login_missing_hash', { uid: record.id });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  const ok = await verifyPassword(input.password, hash);
  if (!ok) {
    logger.warn('auth.login_bad_password', { uid: record.id });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  await data.users.touchLogin(record.id, nowIso());
  return { ...(await loginForUser(record, input.request)), created: false };
}

/**
 * Re-authentication: an already logged-in user must provide their password
 * again to unlock the chat (the third access-flow branch).
 */
export async function reauthenticate(input: {
  password: string;
  request: Request;
}): Promise<AuthOutcome> {
  const verified = await verifySession(input.request);
  if (!verified) {
    throw AppError.unauthenticated('sign in again to continue');
  }
  const data = await getData();
  const record = await data.users.getById(verified.uid);
  if (!record) throw AppError.unauthenticated('sign in again to continue');
  const hash = await data.users.getPasswordHash(record.id);
  if (!hash || !(await verifyPassword(input.password, hash))) {
    throw AppError.unauthenticated('password is incorrect');
  }
  return { ...(await loginForUser(record, input.request)), created: false };
}

export async function logout(request: Request): Promise<{ revoked: boolean; clearCookie: CookieInstruction }> {
  const verified = await verifySession(request);
  if (!verified) return { revoked: false, clearCookie: clearSessionCookie() };
  // Revoke *all* sessions for this user (conservative — safer than leaving
  // other devices logged in after an explicit logout).
  const count = await revokeAllSessionsForUser(verified.uid);
  logger.info('auth.logout', { uid: verified.uid, revoked: count });
  return { revoked: count > 0, clearCookie: clearSessionCookie() };
}

/**
 * Verifies the password for an account that already exists and returns a fresh
 * session. Used by both the "email already registered" branch and the
 * unique-constraint race recovery.
 *
 * The hash is read through `users.getPasswordHash()`, which selects only the
 * `User.passwordHash` column. It is deliberately *not* a field on the
 * `UserRecord`: reading it off the record silently yields `undefined` against
 * PostgreSQL and "works" against the in-memory provider, which is exactly how
 * a successful signup used to be reported as a failure.
 */
async function sessionForExistingAccount(
  existing: UserRecord,
  password: string,
  reason: 'email_taken' | 'race',
  request: Request,
): Promise<Omit<AuthOutcome, 'created'>> {
  const data = await getData();
  const hash = await data.users.getPasswordHash(existing.id);
  const ok = hash ? await verifyPassword(password, hash) : false;
  if (!ok) {
    // Same message as an unknown email/invalid login: no account enumeration.
    logger.warn('auth.register_email_taken_wrong_password', { uid: existing.id, reason });
    throw AppError.unauthenticated('unable to create an account with those details');
  }
  if (existing.status === 'disabled') {
    logger.warn('auth.register_disabled', { uid: existing.id });
    throw AppError.unauthenticated('unable to create an account with those details');
  }
  logger.info('auth.register_idempotent_session', { uid: existing.id, reason });
  await data.users.touchLogin(existing.id, nowIso());
  return loginForUser(existing, request);
}

async function loginForUser(user: UserRecord, request?: Request): Promise<Omit<AuthOutcome, 'created'>> {
  const userAgent = request?.headers.get('user-agent') ?? null;
  const ip = request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const cookie = await createSession({ userId: user.id, userAgent, ip });
  return {
    user: { ...user, isAdmin: isAdminUser(user) },
    token: null,
    cookieSession: true,
    session: cookie,
  };
}

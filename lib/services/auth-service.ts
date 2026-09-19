import { AppError, sanitizeName } from '@mt/domain';
import { nowIso, newUid } from '@mt/utils';
import { getData, type UserRecord } from '../data';
import { hashPassword, verifyPassword } from '../auth/password';
import { createSession, clearSessionCookie, verifySession, revokeAllSessionsForUser, isAdminUser, type CookieInstruction } from '../auth/session';
import { logger } from '../logger';

export interface AuthOutcome {
  user: UserRecord;
  token: null;
  cookieSession: boolean;
  session: CookieInstruction | null;
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
 * Registration: password is verified against Argon2, the user record is
 * created, and a fresh session cookie is issued. Idempotent on email+password.
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
    // To avoid account enumeration, respond exactly as we would for login but
    // do NOT create a new account. A password mismatch becomes a generic 401.
    const ok = await verifyPassword(input.password, (existing as unknown as { passwordHash?: string }).passwordHash ?? '$invalid$');
    if (!ok) {
      logger.warn('auth.register_email_taken_wrong_password', { email });
      throw AppError.unauthenticated('unable to create an account with those details');
    }
    logger.warn('auth.register_email_taken_reissues_session', { email });
    return loginForUser(existing, input.request);
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
  // Persist password hash separately since the UserRecord interface does not
  // expose it to callers above the data layer. We write it directly via Prisma
  // when DATA_PROVIDER=prisma; the memory provider stores it alongside the
  // record in its Map for dev/test parity.
  await createUserWithHash(record, passwordHash);
  await data.users.touchLogin(record.id, now);
  logger.info('auth.profile_created', { uid: record.id });
  return loginForUser(record, input.request);
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
  const hash = await getPasswordHash(record.id);
  if (!hash) {
    logger.warn('auth.login_missing_hash', { uid: record.id });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  const ok = await verifyPassword(input.password, hash);
  if (!ok) {
    logger.warn('auth.login_bad_password', { uid: record.id });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  if (record.status === 'disabled') {
    logger.warn('auth.login_disabled', { uid: record.id });
    throw AppError.unauthenticated('unable to sign in with those details');
  }
  await data.users.touchLogin(record.id, nowIso());
  return loginForUser(record, input.request);
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
  const hash = await getPasswordHash(record.id);
  if (!hash || !(await verifyPassword(input.password, hash))) {
    throw AppError.unauthenticated('password is incorrect');
  }
  return loginForUser(record, input.request);
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

async function loginForUser(user: UserRecord, request: Request): Promise<AuthOutcome> {
  const userAgent = request.headers.get('user-agent');
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const cookie = await createSession({ userId: user.id, userAgent, ip });
  return {
    user: { ...user, isAdmin: isAdminUser(user) },
    token: null,
    cookieSession: true,
    session: cookie,
  };
}

// ---------------------------------------------------------------------------
// Password-hash persistence helpers. These are deliberately small so the
// memory and prisma providers don't need schema changes to hold a hash.
// ---------------------------------------------------------------------------

async function createUserWithHash(record: UserRecord, passwordHash: string): Promise<void> {
  const data = await getData();
  if (data.name === 'prisma') {
    const { getPrisma } = await import('../prisma');
    const prisma = await getPrisma();
    await prisma.user.create({
      data: {
        id: record.id,
        name: record.name,
        email: record.email,
        emailNormalized: record.email.toLowerCase(),
        passwordHash,
        photoUrl: record.photoUrl,
        status: record.status,
        disabledReason: record.disabledReason,
        lastLoginAt: record.lastLoginAt ? new Date(record.lastLoginAt) : null,
      },
    });
    return;
  }
  // Memory provider path: stash the hash on the Map entry directly.
  const target = globalThis as unknown as Record<string, any>;
  const store = target.__mt_memory_store_v1;
  const users = store?.users as Map<string, UserRecord & { passwordHash?: string }> | undefined;
  const created = await data.users.create(record);
  users?.set(record.id, { ...created, passwordHash });
}

async function getPasswordHash(userId: string): Promise<string | null> {
  const data = await getData();
  if (data.name === 'prisma') {
    const { getPrisma } = await import('../prisma');
    const prisma = await getPrisma();
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    return (row as { passwordHash?: string | null } | null)?.passwordHash ?? null;
  }
  const target = globalThis as unknown as Record<string, any>;
  const store = target.__mt_memory_store_v1;
  const users = store?.users as Map<string, UserRecord & { passwordHash?: string }> | undefined;
  return users?.get(userId)?.passwordHash ?? null;
}

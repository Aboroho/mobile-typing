import { deterministicUid, nowIso } from '@mt/utils';
import { signToken, verifyToken } from '@mt/domain';
import { AppError } from '@mt/domain';
import { env } from '../env';
import { getData } from '../data';
import { hashPassword, verifyPassword as checkPassword } from './password';
import type { AuthProvider, AuthUserRecord, VerifiedToken } from './types';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Development auth provider.
 *
 * It deliberately mirrors the Firebase flow: the client authenticates against
 * `/api/v1/auth/*`, receives a bearer token, and every later request presents
 * that token, which the server verifies with `verifyToken`. Swapping to Firebase
 * changes only which implementation answers these calls.
 */
export function createDevAuthProvider(): AuthProvider {
  return {
    name: 'dev',
    async verifyToken(token: string): Promise<VerifiedToken | null> {
      const claims = await verifyToken<{ aud: string; sub: string; email: string; auth_time: number }>(
        env().DEV_SESSION_SECRET,
        token,
        { audience: 'mt-session' },
      );
      if (!claims) return null;
      return {
        uid: claims.sub,
        email: claims.email,
        authTime: claims.auth_time,
        tokenId: null,
        isAdminClaim: false,
      };
    },
    async createUser(input: { email: string; password: string; name: string }): Promise<AuthUserRecord> {
      const data = await getData();
      const existing = await data.users.getByEmail(input.email);
      if (existing) {
        // Same opaque message the login route returns, so registration cannot be
        // used to discover which emails already have an account.
        throw AppError.conflict('unable to create that account');
      }
      const { hash, salt } = hashPassword(input.password);
      const now = nowIso();
      const uid = deterministicUid(input.email);
      await data.users.create({
        id: uid,
        name: input.name,
        email: input.email.trim().toLowerCase(),
        photoUrl: null,
        status: 'active',
        lastLoginAt: now,
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
        passwordHash: hash,
        passwordSalt: salt,
        disabledReason: null,
      });
      return { uid, email: input.email.trim().toLowerCase(), name: input.name, disabled: false };
    },
    async verifyPassword(email: string, password: string): Promise<AuthUserRecord | null> {
      const data = await getData();
      const record = await data.users.getByEmail(email);
      if (!record || !record.passwordHash || !record.passwordSalt) return null;
      if (!checkPassword(password, record.passwordHash, record.passwordSalt)) return null;
      return {
        uid: record.id,
        email: record.email,
        name: record.name,
        disabled: record.status === 'disabled',
      };
    },
    async setDisabled(uid: string, disabled: boolean): Promise<void> {
      const data = await getData();
      await data.users.update(uid, {
        status: disabled ? 'disabled' : 'active',
        disabledReason: disabled ? 'disabled by administrator' : null,
      });
    },
    async sendPasswordReset(email: string): Promise<boolean> {
      const data = await getData();
      const record = await data.users.getByEmail(email);
      // Always reports success: the response must not reveal account existence.
      return Boolean(record);
    },
  };
}

/** Issues the bearer token the dev client stores after a successful login. */
export async function issueDevSessionToken(input: {
  uid: string;
  email: string;
  authTime: number;
}): Promise<{ token: string; expiresAt: string }> {
  return signToken(
    env().DEV_SESSION_SECRET,
    {
      aud: 'mt-session',
      sub: input.uid,
      email: input.email,
      auth_time: input.authTime,
    },
    TOKEN_TTL_MS,
  );
}

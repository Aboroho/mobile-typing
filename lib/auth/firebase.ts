import { AppError } from '@mt/domain';
import { getAdminAuth } from '../firebase/admin';
import { getData } from '../data';
import { logger } from '../logger';
import type { AuthProvider, AuthUserRecord, VerifiedToken } from './types';

/**
 * Firebase Authentication provider. Password verification happens on the client
 * with `signInWithEmailAndPassword` / `reauthenticateWithCredential`; the server
 * only ever sees (and verifies) ID tokens.
 */
export function createFirebaseAuthProvider(): AuthProvider {
  return {
    name: 'firebase',
    async verifyToken(token: string): Promise<VerifiedToken | null> {
      try {
        const decoded = await getAdminAuth().verifyIdToken(token, true);
        return {
          uid: decoded.uid,
          email: decoded.email ?? '',
          authTime: decoded.auth_time ?? Math.floor(Date.now() / 1000),
          tokenId: decoded.sub,
          isAdminClaim: decoded.role === 'admin' || decoded.admin === true,
        };
      } catch (error) {
        // Never log the token or the SDK error verbatim: Firebase errors can
        // include request details. The event still gives operators a useful
        // signal when project/audience, expiry, revocation, or Admin config is
        // wrong.
        logger.warn('auth.firebase_token_verification_failed', {
          reason: error instanceof Error ? error.name : 'unknown_error',
        });
        return null;
      }
    },
    async createUser(input: { email: string; password: string; name: string }): Promise<AuthUserRecord> {
      const created = await getAdminAuth().createUser({
        email: input.email.trim().toLowerCase(),
        password: input.password,
        displayName: input.name,
        emailVerified: false,
      });
      return {
        uid: created.uid,
        email: created.email ?? input.email.trim().toLowerCase(),
        name: created.displayName ?? input.name,
        disabled: Boolean(created.disabled),
      };
    },
    async verifyPassword(): Promise<AuthUserRecord | null> {
      throw new AppError(
        'NOT_IMPLEMENTED',
        'password verification is performed by Firebase Authentication on the client',
      );
    },
    async setDisabled(uid: string, disabled: boolean): Promise<void> {
      await getAdminAuth().updateUser(uid, { disabled });
      const data = await getData();
      await data.users.update(uid, { status: disabled ? 'disabled' : 'active' });
    },
    async sendPasswordReset(email: string): Promise<boolean> {
      const link = await getAdminAuth().generatePasswordResetLink(email.trim().toLowerCase());
      // The link is emailed by whatever mail transport is configured; it is never
      // returned to the caller because that would disclose account existence.
      return Boolean(link);
    },
  };
}

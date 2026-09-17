import type { UserRecord } from '../data/types';

export interface VerifiedToken {
  uid: string;
  email: string;
  /** Seconds since epoch when the credential was last verified. */
  authTime: number;
  /** Firebase token id, used for revocation checks. */
  tokenId: string | null;
  isAdminClaim: boolean;
}

export interface AuthUserRecord {
  uid: string;
  email: string;
  name: string;
  disabled: boolean;
}

/**
 * Authentication boundary. `firebase` delegates to Firebase Authentication;
 * `dev` is a self-contained email/password provider used for local development
 * and tests (it hashes passwords with scrypt and issues the same style of
 * bearer token, so the rest of the stack is identical).
 */
export interface AuthProvider {
  readonly name: 'firebase' | 'dev';
  verifyToken(token: string): Promise<VerifiedToken | null>;
  createUser(input: { email: string; password: string; name: string }): Promise<AuthUserRecord>;
  /** Dev only: Firebase verifies passwords on the client and returns an ID token. */
  verifyPassword(email: string, password: string): Promise<AuthUserRecord | null>;
  setDisabled(uid: string, disabled: boolean): Promise<void>;
  sendPasswordReset(email: string): Promise<boolean>;
}

export interface ResolvedAuth {
  user: UserRecord;
  token: VerifiedToken;
}

/** Cookie names. Both are httpOnly; the access cookie is what gates the chat UI. */
export const SESSION_COOKIE = 'mt_session';
export const ACCESS_COOKIE = 'mt_access';

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

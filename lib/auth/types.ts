import type { UserRecord } from '../data/types';

/**
 * Where a verified credential came from.
 *
 * Sessions are opaque 256-bit tokens, stored hashed (SHA-256) in the database
 * (`UserSession`) and presented either as `Authorization: Bearer <token>` or
 * as the httpOnly `mt_session` cookie. The cookie is the only credential a
 * browser can present on an `EventSource` request (SSE streams cannot set
 * headers).
 */
export type CredentialSource = 'session-cookie';

export interface VerifiedToken {
  /** User id — the canonical identity of an account in this application. */
  uid: string;
  email: string;
  /** Display name, when the account has one. Never trusted as an id. */
  displayName: string | null;
  /** Seconds since epoch when the session was created. */
  authTime: number;
  /**
   * Whether the user is the configured administrator. Computed server side
   * by `isAdminUser()` from `ADMIN_UID`/`ADMIN_EMAIL` on every request —
   * never stored on the session and never trusted from the client.
   */
  isAdminClaim: boolean;
  source: CredentialSource;
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

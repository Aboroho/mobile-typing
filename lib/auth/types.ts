import type { UserRecord } from '../data/types';

/**
 * Where a verified credential came from.
 *
 *  - `id-token`       `Authorization: Bearer <Firebase ID token>`, the credential
 *                     the browser SDK holds. Short lived (1 hour, refreshed by the
 *                     SDK) and the only credential that can be exchanged for a
 *                     session cookie.
 *  - `session-cookie` the httpOnly `mt_session` cookie, whose value is a Firebase
 *                     session cookie minted by this API. Long lived, and the only
 *                     credential a browser can present on an `EventSource`
 *                     request (the SSE streams cannot set headers).
 */
export type CredentialSource = 'id-token' | 'session-cookie';

export interface VerifiedToken {
  /** Firebase uid — the canonical identity of an account in this application. */
  uid: string;
  email: string;
  /** Firebase display name, when the account has one. Never trusted as an id. */
  displayName: string | null;
  /** Seconds since epoch when the user last authenticated (Firebase `auth_time`). */
  authTime: number;
  /**
   * The `role: 'admin'` custom claim, when present. Reported for diagnostics
   * only: API authorisation is decided by `isAdminUser()` from the server
   * environment, never by a claim a client could ask to have set.
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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * An in-process double for Firebase Authentication.
 *
 * The unit tests exercise the real application code — routes, guards, services,
 * validation and the data layer — and replace only the external identity
 * provider, which is the same thing the Firebase Auth emulator does (and the
 * emulator needs a JVM plus `firebase-tools`, neither of which the test suite
 * should require).
 *
 * Two surfaces live here, because that is how Firebase is split in production:
 *
 *  - the **browser SDK** calls (`signUpWithPassword`, `signInWithPassword`,
 *    `reauthenticateWithPassword`) that create accounts and hand out ID tokens;
 *  - the **Admin SDK** surface used by `lib/auth/firebase.ts`
 *    (`verifyIdToken`, `verifySessionCookie`, `createSessionCookie`,
 *    `revokeRefreshTokens`, `updateUser`, `getUserByEmail`).
 *
 * The Admin surface keeps the real semantics the application relies on: tokens
 * are signed and tampering is detected, `createSessionCookie` refuses a
 * credential whose `auth_time` is older than five minutes, and revocation makes
 * every earlier credential fail a `checkRevoked` verification.
 */

const SIGNING_KEY = 'fake-firebase-auth-signing-key';
const PROJECT_ID = 'keypad-test';
const ID_TOKEN_TTL_SECONDS = 60 * 60;
/** Firebase accepts a session cookie TTL between 5 minutes and 14 days. */
const SESSION_COOKIE_MIN_MS = 5 * 60 * 1000;
const SESSION_COOKIE_MAX_MS = 14 * 24 * 60 * 60 * 1000;
/** A credential may only be upgraded into a session cookie while this fresh. */
const FRESH_CREDENTIAL_SECONDS = 5 * 60;
/** Passwords shorter than this are refused by Firebase, not by us. */
const FIREBASE_PASSWORD_MIN_LENGTH = 6;

export class FirebaseAuthError extends Error {
  readonly errorInfo: { code: string };

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'FirebaseAuthError';
    this.errorInfo = { code };
  }
}

export interface FakeFirebaseAccount {
  uid: string;
  email: string;
  password: string;
  displayName: string | null;
  disabled: boolean;
  /** Epoch seconds; credentials issued at or before this are revoked. */
  validSince: number;
}

type CredentialKind = 'id-token' | 'session-cookie';

interface Claims {
  uid: string;
  sub: string;
  aud: string;
  iss: string;
  iat: number;
  exp: number;
  auth_time: number;
  email?: string;
  name?: string;
  kind: CredentialKind;
  /** Random per issuance, so two credentials for the same user never match. */
  jti?: string;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signatureOf(payload: string): string {
  return createHmac('sha256', SIGNING_KEY).update(payload).digest('base64url');
}

function issue(claims: Claims): string {
  const payload = base64url(JSON.stringify({ ...claims, jti: randomBytes(8).toString('hex') }));
  return `${payload}.${signatureOf(payload)}`;
}

/** `null` when the token is malformed or was tampered with. */
function decode(credential: string): Claims | null {
  const separator = credential.lastIndexOf('.');
  if (separator <= 0) return null;
  const payload = credential.slice(0, separator);
  const signature = Buffer.from(credential.slice(separator + 1));
  const expected = Buffer.from(signatureOf(payload));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
  } catch {
    return null;
  }
}

/** What a verified credential looks like to the caller (Admin SDK shape). */
export interface DecodedClaims {
  uid: string;
  sub: string;
  aud: string;
  iss: string;
  iat: number;
  exp: number;
  auth_time: number;
  email?: string;
  name?: string;
  kind: CredentialKind;
  [claim: string]: unknown;
}

export interface SignUpInput {
  email: string;
  password: string;
  displayName?: string | null;
}

export interface IssueOptions {
  /** Backdate `auth_time` (and `iat`) to test the freshness rule. */
  ageSeconds?: number;
  /** Produce a session cookie instead of an ID token (test fixture only). */
  kind?: CredentialKind;
}

export class FakeFirebaseAdminAuth {
  private accounts = new Map<string, FakeFirebaseAccount>();

  reset(): void {
    this.accounts.clear();
  }

  get size(): number {
    return this.accounts.size;
  }

  account(uid: string): FakeFirebaseAccount | undefined {
    const account = this.accounts.get(uid);
    return account ? { ...account } : undefined;
  }

  // --- what the browser SDK does -------------------------------------------

  /** `createUserWithEmailAndPassword` + `updateProfile` + `getIdToken`. */
  signUpWithPassword(input: SignUpInput): { uid: string; idToken: string } {
    const email = input.email.trim().toLowerCase();
    if (this.findByEmail(email)) throw new FirebaseAuthError('auth/email-already-in-use');
    if (input.password.length < FIREBASE_PASSWORD_MIN_LENGTH) {
      throw new FirebaseAuthError('auth/weak-password');
    }
    const uid = `fb_${randomBytes(10).toString('hex')}`;
    this.accounts.set(uid, {
      uid,
      email,
      password: input.password,
      displayName: input.displayName ?? null,
      disabled: false,
      validSince: 0,
    });
    return { uid, idToken: this.issueFor(uid, { kind: 'id-token' }) };
  }

  /** `signInWithEmailAndPassword`: refuses a wrong password or a known email. */
  signInWithPassword(email: string, password: string): { uid: string; idToken: string } {
    const account = this.findByEmail(email.trim().toLowerCase());
    // One code for both failures, exactly like Firebase: an unknown email and a
    // wrong password must be indistinguishable.
    if (!account || account.password !== password) {
      throw new FirebaseAuthError('auth/invalid-login-credentials');
    }
    if (account.disabled) throw new FirebaseAuthError('auth/user-disabled');
    return { uid: account.uid, idToken: this.issueFor(account.uid, { kind: 'id-token' }) };
  }

  /** `reauthenticateWithCredential`: proves the password, resets `auth_time`. */
  reauthenticateWithPassword(uid: string, password: string): { idToken: string } {
    const account = this.require(uid);
    if (account.password !== password) throw new FirebaseAuthError('auth/invalid-credential');
    return { idToken: this.issueFor(uid, { kind: 'id-token' }) };
  }

  /** `updateProfile` in the browser SDK. */
  updateDisplayName(uid: string, displayName: string): void {
    const account = this.require(uid);
    account.displayName = displayName;
  }

  /**
   * Mints a credential for an existing account, optionally backdated. Used to
   * test the freshness rule and revocation without waiting five minutes.
   */
  issueFor(uid: string, options: IssueOptions = {}): string {
    const account = this.require(uid);
    const ageSeconds = options.ageSeconds ?? 0;
    const now = Math.floor(Date.now() / 1000) - ageSeconds;
    const claims: Claims = {
      uid: account.uid,
      sub: account.uid,
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      iat: now,
      exp: now + ID_TOKEN_TTL_SECONDS,
      auth_time: now,
      kind: options.kind ?? 'id-token',
      ...(account.email ? { email: account.email } : {}),
      ...(account.displayName ? { name: account.displayName } : {}),
    };
    return issue(claims);
  }

  /** A credential that never came from this provider. */
  forgeToken(uid: string): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = base64url(
      JSON.stringify({
        uid,
        sub: uid,
        aud: PROJECT_ID,
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        iat: now,
        exp: now + ID_TOKEN_TTL_SECONDS,
        auth_time: now,
        kind: 'id-token',
      } satisfies Omit<Claims, 'email' | 'name'>),
    );
    return `${payload}.forged-signature`;
  }

  // --- the Admin SDK surface used by lib/auth/firebase.ts -------------------

  async verifyIdToken(token: string, checkRevoked = false): Promise<DecodedClaims> {
    return this.verify(token, 'id-token', checkRevoked);
  }

  async verifySessionCookie(sessionCookie: string, checkRevoked = false): Promise<DecodedClaims> {
    return this.verify(sessionCookie, 'session-cookie', checkRevoked);
  }

  async createSessionCookie(idToken: string, options: { expiresIn: number }): Promise<string> {
    if (
      !Number.isFinite(options.expiresIn) ||
      options.expiresIn < SESSION_COOKIE_MIN_MS ||
      options.expiresIn > SESSION_COOKIE_MAX_MS
    ) {
      throw new FirebaseAuthError('auth/argument-error', 'expiresIn must be between 5 minutes and 14 days');
    }
    const decoded = await this.verify(idToken, 'id-token', false);
    // The backend refuses to upgrade a credential that is not recent, which is
    // what stops a long-leaked ID token becoming a two-week session.
    if (Date.now() / 1000 - decoded.auth_time > FRESH_CREDENTIAL_SECONDS) {
      throw new FirebaseAuthError('auth/argument-error', 'the ID token is not fresh enough');
    }
    const now = Math.floor(Date.now() / 1000);
    return issue({
      uid: decoded.uid,
      sub: decoded.uid,
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      iat: now,
      exp: now + Math.floor(options.expiresIn / 1000),
      auth_time: decoded.auth_time,
      kind: 'session-cookie',
      ...(decoded.email ? { email: decoded.email } : {}),
      ...(decoded.name ? { name: decoded.name } : {}),
    });
  }

  async revokeRefreshTokens(uid: string): Promise<void> {
    const account = this.require(uid);
    account.validSince = Math.floor(Date.now() / 1000);
  }

  async updateUser(uid: string, patch: { disabled?: boolean; displayName?: string }): Promise<void> {
    const account = this.require(uid);
    if (patch.disabled !== undefined) account.disabled = patch.disabled;
    if (patch.displayName !== undefined) account.displayName = patch.displayName;
  }

  async getUserByEmail(email: string) {
    const account = this.findByEmail(email.trim().toLowerCase());
    if (!account) throw new FirebaseAuthError('auth/user-not-found');
    return { ...account };
  }

  // --- internals ------------------------------------------------------------

  private verify(credential: string, kind: CredentialKind, checkRevoked: boolean): DecodedClaims {
    const claims = decode(credential);
    if (!claims) throw new FirebaseAuthError('auth/argument-error', 'the credential could not be parsed');
    if (claims.kind !== kind) {
      throw new FirebaseAuthError(
        kind === 'session-cookie' ? 'auth/session-cookie-expired' : 'auth/invalid-id-token',
        'the credential is not of the expected kind',
      );
    }
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) {
      throw new FirebaseAuthError(
        kind === 'session-cookie' ? 'auth/session-cookie-expired' : 'auth/id-token-expired',
      );
    }
    const account = this.accounts.get(claims.uid);
    if (!account) throw new FirebaseAuthError('auth/user-not-found');
    if (checkRevoked && claims.iat <= account.validSince) {
      throw new FirebaseAuthError(
        kind === 'session-cookie' ? 'auth/session-cookie-revoked' : 'auth/id-token-revoked',
      );
    }
    if (checkRevoked && account.disabled) throw new FirebaseAuthError('auth/user-disabled');
    return { ...claims };
  }

  private require(uid: string): FakeFirebaseAccount {
    const account = this.accounts.get(uid);
    if (!account) throw new FirebaseAuthError('auth/user-not-found');
    return account;
  }

  private findByEmail(email: string): FakeFirebaseAccount | undefined {
    for (const account of this.accounts.values()) {
      if (account.email === email) return account;
    }
    return undefined;
  }
}

/**
 * The single instance the mocked Admin SDK hands out.
 *
 * It hangs off `globalThis` so that the setup file, the mock factory and a test
 * file all share one registry even if the module is evaluated more than once in
 * a worker.
 */
const shared = globalThis as { __mtFakeFirebaseAdminAuth?: FakeFirebaseAdminAuth };
export const fakeAdminAuth: FakeFirebaseAdminAuth =
  shared.__mtFakeFirebaseAdminAuth ?? (shared.__mtFakeFirebaseAdminAuth = new FakeFirebaseAdminAuth());

/** Test helper: forget every account, the way `resetStore()` forgets every row. */
export function resetFirebaseAuth(): void {
  fakeAdminAuth.reset();
}

/**
 * Browser authentication client.
 *
 * Authentication is cookie-based: the server sets an HttpOnly session cookie on
 * register/login/reauth and clears it on logout. The browser never sees a raw
 * credential, and all API calls are made with `credentials: 'include'` so the
 * cookie is sent automatically.
 *
 * This module is a thin state layer on top of the typed API client
 * (`lib/api-client`): it owns "who is the current user" for the browser and
 * broadcasts changes so the stores stay in sync. It does **not** implement its
 * own HTTP calls — that duplication is what caused signup to be submitted
 * twice, once here and once through `api`, so the second response decided the
 * UI's success/failure message. Every request now goes through `api` exactly
 * once.
 */
import type { AuthResult, ReauthenticateResult, SessionUser } from '@mt/api-client';
import { ApiClientError } from '@mt/api-client';
import { api } from '@/lib/client/api';

export interface AuthClientUser {
  id: string;
  email: string | null;
  name: string | null;
  displayName: string | null; // alias for name; backwards-compat
  isAdmin: boolean;
}

export interface AuthClientResult {
  user: AuthClientUser;
  /** The full session user exactly as the API returned it (no extra request). */
  sessionUser: SessionUser;
  /** True when the server created the account (201) rather than re-issuing a session. */
  created: boolean;
  /** True when the server also bound the access session to this user. */
  accessGranted: boolean;
}

export interface AuthClient {
  getToken(): Promise<string | null>;
  getCurrentUser(): AuthClientUser | null;
  waitForAuthReady(): Promise<AuthClientUser | null>;
  onAuthChange(callback: (userId: string | null) => void): () => void;
  signUp(input: { email: string; password: string; name: string }): Promise<AuthClientResult>;
  signIn(input: { email: string; password: string }): Promise<AuthClientResult>;
  reauthenticate(password: string): Promise<AuthClientResult>;
  /** Password reset is not yet implemented; throws a descriptive error. */
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<AuthClientUser | null>;
  /** Records an already-known user without another network round trip. */
  adopt(user: AuthClientUser | null): void;
  /** The full session user from the last successful call, if any. */
  getSessionUser(): SessionUser | null;
}

type Listener = (userId: string | null) => void;

export class AuthClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'AuthClientError';
  }
}

function toAuthClientUser(user: SessionUser | null): AuthClientUser | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    displayName: user.name,
    isAdmin: user.isAdmin,
  };
}

function createAuthClient(): AuthClient {
  let currentUser: AuthClientUser | null | undefined = undefined;
  let currentSessionUser: SessionUser | null = null;
  const listeners = new Set<Listener>();
  let readyPromise: Promise<AuthClientUser | null> | null = null;

  function emit(user: AuthClientUser | null) {
    const changed = currentUser?.id !== user?.id;
    currentUser = user;
    if (changed) for (const l of listeners) l(user?.id ?? null);
  }

  async function load(): Promise<AuthClientUser | null> {
    try {
      const { user } = await api.auth.me();
      currentSessionUser = user;
      const next = toAuthClientUser(user);
      emit(next);
      return next;
    } catch {
      currentSessionUser = null;
      emit(null);
      return null;
    }
  }

  function ready(): Promise<AuthClientUser | null> {
    if (currentUser !== undefined) return Promise.resolve(currentUser);
    if (!readyPromise) readyPromise = load();
    return readyPromise;
  }

  function toResult(result: AuthResult | ReauthenticateResult, created: boolean): AuthClientResult {
    const user = toAuthClientUser(result.user);
    currentSessionUser = result.user;
    emit(user);
    return {
      user: user!,
      sessionUser: result.user,
      created,
      accessGranted: 'accessGranted' in result ? Boolean(result.accessGranted) : false,
    };
  }

  return {
    async getToken(): Promise<string | null> {
      // Cookie-based auth: there is no client-held bearer token. The fetch
      // client sends credentials:'include' so the HttpOnly cookie is sent.
      return null;
    },
    getCurrentUser() {
      return currentUser ?? null;
    },
    waitForAuthReady() {
      return ready();
    },
    onAuthChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    adopt(user) {
      emit(user);
    },
    getSessionUser() {
      return currentSessionUser;
    },
    async signUp(input) {
      const result = await api.auth.register({
        name: input.name,
        email: input.email,
        password: input.password,
      });
      // A duplicate submit for an existing email returns 200 instead of 201;
      // both are success, so the flag is carried rather than thrown on.
      return toResult(result, result.created !== false);
    },
    async signIn(input) {
      const result = await api.auth.login({ email: input.email, password: input.password });
      return toResult(result, false);
    },
    async reauthenticate(password) {
      const result = await api.auth.reauthenticate({ password });
      return toResult(result, false);
    },
    async sendPasswordReset(_email: string) {
      // Password reset via email has not been implemented yet (needs an email
      // provider). The UI surface is preserved so the UX isn't broken, but we
      // reject with a clear message so the operator knows it must be wired up.
      throw new AuthClientError(501, 'password reset is not configured for this deployment');
    },
    async signOut() {
      try {
        await api.auth.logout();
      } catch {
        // Ignore network errors; the cookie is cleared by the server anyway.
      }
      currentSessionUser = null;
      emit(null);
    },
    async refresh() {
      return load();
    },
  };
}

let clientPromise: Promise<AuthClient> | null = null;

export function getAuthClient(): Promise<AuthClient> {
  if (!clientPromise) clientPromise = Promise.resolve(createAuthClient());
  return clientPromise;
}

export function resetAuthClient(): void {
  clientPromise = null;
}

/**
 * Map an HTTP response to a user-safe error message. Mirrors the server error
 * envelope (`{ ok: false, error: { code, message } }`).
 */
export function authClientMessage(error: unknown): string | null {
  if (error instanceof ApiClientError || error instanceof AuthClientError) {
    return error.message || 'authentication failed';
  }
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

/**
 * Browser authentication client.
 *
 * Authentication is cookie-based: the server sets an HttpOnly session cookie on
 * register/login/reauth and clears it on logout. The browser never sees a raw
 * credential, and all API calls are made with `credentials: 'include'` so the
 * cookie is sent automatically.
 *
 * This module exists to give the rest of the client code a simple interface for
 * reading the current user and subscribing to changes. User state is fetched
 * from `/api/v1/auth/me`, and changes are broadcast through an event bus so
 * multiple stores stay in sync.
 */
import { parsePublicEnv } from '@mt/config';

export interface AuthClientUser {
  id: string;
  email: string | null;
  name: string | null;
  displayName: string | null; // alias for name; backwards-compat
  isAdmin: boolean;
}

export interface AuthClient {
  getToken(): Promise<string | null>;
  getCurrentUser(): AuthClientUser | null;
  waitForAuthReady(): Promise<AuthClientUser | null>;
  onAuthChange(callback: (userId: string | null) => void): () => void;
  signUp(input: { email: string; password: string; name: string }): Promise<{ user: AuthClientUser }>;
  signIn(input: { email: string; password: string }): Promise<{ user: AuthClientUser }>;
  reauthenticate(password: string): Promise<{ user: AuthClientUser }>;
  /** Password reset is not yet implemented; throws a descriptive error. */
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<AuthClientUser | null>;
}

type Listener = (userId: string | null) => void;

function authEndpoint(path: string): string {
  const env = parsePublicEnv();
  return `${env.NEXT_PUBLIC_APP_URL}/api/v1/auth${path}`;
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      const json = JSON.parse(text) as { error?: { message?: string } };
      if (json.error?.message) message = json.error.message;
    } catch {
      // ignore JSON parse error, use raw text
    }
    throw new AuthClientError(res.status, message || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export class AuthClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'AuthClientError';
  }
}

function createAuthClient(): AuthClient {
  let currentUser: AuthClientUser | null | undefined = undefined;
  const listeners = new Set<Listener>();
  let readyPromise: Promise<AuthClientUser | null> | null = null;

  function emit(user: AuthClientUser | null) {
    if (currentUser?.id === user?.id) return;
    currentUser = user;
    for (const l of listeners) l(user?.id ?? null);
  }

  function normalise(u: AuthClientUser | null): AuthClientUser | null {
    if (!u) return null;
    return { ...u, displayName: u.name };
  }
  async function load(): Promise<AuthClientUser | null> {
    try {
      const res = await fetchJson<{ user: AuthClientUser | null }>(authEndpoint('/me'));
      const u = normalise(res.user);
      emit(u);
      return u;
    } catch {
      emit(null);
      return null;
    }
  }

  function ready(): Promise<AuthClientUser | null> {
    if (currentUser !== undefined) return Promise.resolve(currentUser);
    if (!readyPromise) readyPromise = load();
    return readyPromise;
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
    async signUp(input) {
      const res = await fetchJson<{ user: AuthClientUser }>(authEndpoint('/register'), {
        method: 'POST',
        body: JSON.stringify({ name: input.name, email: input.email, password: input.password }),
      });
      const u = normalise(res.user);
      emit(u);
      return { ...res, user: u! };
    },
    async signIn(input) {
      const res = await fetchJson<{ user: AuthClientUser }>(authEndpoint('/login'), {
        method: 'POST',
        body: JSON.stringify({ email: input.email, password: input.password }),
      });
      const u = normalise(res.user);
      emit(u);
      return { ...res, user: u! };
    },
    async reauthenticate(password) {
      const res = await fetchJson<{ user: AuthClientUser }>(authEndpoint('/reauthenticate'), {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      const u = normalise(res.user);
      emit(u);
      return { ...res, user: u! };
    },
    async sendPasswordReset(_email: string) {
      // Password reset via email has not been implemented yet (needs an email
      // provider). The UI surface is preserved so the UX isn't broken, but we
      // reject with a clear message so the operator knows it must be wired up.
      throw new AuthClientError(501, 'password reset is not configured for this deployment');
    },
    async signOut() {
      try {
        await fetch(authEndpoint('/logout'), { method: 'POST', credentials: 'include' });
      } catch {
        // Ignore network errors; cookie is cleared on the server response anyway.
      }
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
 * Map an HTTP response to a user-safe error message. Mirror server error codes.
 */
export function authClientMessage(error: unknown): string | null {
  if (error instanceof AuthClientError) {
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

// Backwards-compatible alias used in a few places.
export function firebaseAuthMessage(error: unknown): string | null {
  return authClientMessage(error);
}

import { create } from 'zustand';
import type { SessionUser } from '@mt/api-client';
import type { LoginFormValues, RegisterFormValues } from '@mt/validation';
import { setAuthTokenProvider } from '@/lib/client/api';
import { authClientMessage, getAuthClient } from '@/lib/client/auth-client';
import { useRealtimeStore } from './realtime-store';
import { errorMessage, useAccessStore } from './access-store';

interface AuthActionResult {
  ok: boolean;
  accessGranted: boolean;
}

interface AuthState {
  user: SessionUser | null;
  initializing: boolean;
  error: string | null;
  /** True while a signup/login request is in flight (guards double submits). */
  pending: boolean;
  initialize: () => Promise<void>;
  register: (input: RegisterFormValues) => Promise<AuthActionResult>;
  login: (input: LoginFormValues) => Promise<AuthActionResult>;
  reauthenticate: (password: string) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  handleSessionRequired: () => void;
}

function authErrorMessage(error: unknown): string {
  return authClientMessage(error) ?? errorMessage(error);
}

/**
 * One in-flight guard for all three credential actions.
 *
 * Without it a double-clicked button, an Enter press plus a click, or a browser
 * form resubmission sends the same credentials twice. The server is idempotent
 * either way, but the second response would otherwise overwrite the first
 * success and the UI would report a failure for an account that exists.
 */
let inFlight: Promise<AuthActionResult> | null = null;

async function runExclusive(action: () => Promise<AuthActionResult>): Promise<AuthActionResult> {
  if (inFlight) return inFlight;
  inFlight = action().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  initializing: true,
  error: null,
  pending: false,

  async initialize() {
    if (!get().initializing) return;
    setAuthTokenProvider(async () => null); // Cookie-based auth: no bearer token.
    try {
      const client = await getAuthClient();
      const user = await client.waitForAuthReady();
      const sessionUser = client.getSessionUser();
      if (user && sessionUser) {
        // The auth client already resolved `/auth/me`; reuse that response
        // instead of asking twice, then track later sign-outs.
        client.onAuthChange((uid) => {
          if (!uid) set({ user: null });
        });
        set({ user: sessionUser, initializing: false, error: null });
        // Realtime is a separate concern: if it cannot connect, the session is
        // still valid and the user is still signed in.
        useRealtimeStore.getState().start();
        return;
      }
      set({ user: null, initializing: false });
    } catch {
      set({ user: null, initializing: false });
    }
  },

  /**
   * Signup.
   *
   * Exactly one `POST /api/v1/auth/register`. The response carries the session
   * user, so the store is authenticated the moment it resolves — no page
   * refresh, no second request, and no dependency on the WebSocket.
   */
  register({ name, email, password }) {
    return runExclusive(async () => {
      set({ pending: true, error: null });
      try {
        const client = await getAuthClient();
        const result = await client.signUp({ email, password, name });
        // The register response already carries the full session user, so the
        // store is authenticated without another round trip or a refresh.
        set({ user: result.sessionUser, error: null, pending: false });
        if (result.accessGranted) {
          useAccessStore.setState({ boundUserId: result.user.id });
        }
        // Independent of signup success: failures here surface as a connection
        // warning only.
        useRealtimeStore.getState().start();
        return { ok: true, accessGranted: result.accessGranted };
      } catch (error) {
        set({ error: authErrorMessage(error), pending: false });
        return { ok: false, accessGranted: false };
      }
    });
  },

  login({ email, password }) {
    return runExclusive(async () => {
      set({ pending: true, error: null });
      try {
        const client = await getAuthClient();
        const result = await client.signIn({ email, password });
        const { api } = await import('@/lib/client/api');
        const { user } = await api.auth.me();
        set({ user, error: null, pending: false });
        if (result.accessGranted) {
          useAccessStore.setState({ boundUserId: result.user.id });
        }
        useRealtimeStore.getState().start();
        return { ok: true, accessGranted: result.accessGranted };
      } catch (error) {
        set({ error: authErrorMessage(error), pending: false });
        return { ok: false, accessGranted: false };
      }
    });
  },

  reauthenticate(password) {
    return runExclusive(async () => {
      set({ pending: true, error: null });
      try {
        const client = await getAuthClient();
        const result = await client.reauthenticate(password);
        const { api } = await import('@/lib/client/api');
        const { user } = await api.auth.me();
        set({ user: user ?? get().user, error: null, pending: false });
        if (result.accessGranted) {
          useAccessStore.setState({ boundUserId: result.user.id });
        }
        useRealtimeStore.getState().start();
        return { ok: true, accessGranted: result.accessGranted };
      } catch (error) {
        set({ error: authErrorMessage(error), pending: false });
        return { ok: false, accessGranted: false };
      }
    });
  },

  async logout() {
    const { api } = await import('@/lib/client/api');
    await api.auth.logout().catch(() => undefined);
    try {
      const client = await getAuthClient();
      await client.signOut();
    } catch {
      // Session already cleared server side.
    }
    useRealtimeStore.getState().stop();
    useAccessStore.setState({ boundUserId: null });
    set({ user: null, error: null, pending: false });
  },

  handleSessionRequired() {
    if (get().user) set({ user: null });
    useRealtimeStore.getState().stop();
  },
}));

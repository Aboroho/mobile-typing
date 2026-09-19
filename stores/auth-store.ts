import { create } from 'zustand';
import type { SessionUser } from '@mt/api-client';
import type { LoginFormValues, RegisterFormValues } from '@mt/validation';
import { api, setAuthTokenProvider } from '@/lib/client/api';
import { authClientMessage, getAuthClient } from '@/lib/client/auth-client';
import { errorMessage, useAccessStore } from './access-store';

interface AuthActionResult {
  ok: boolean;
  accessGranted: boolean;
}

interface AuthState {
  user: SessionUser | null;
  initializing: boolean;
  error: string | null;
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

async function loadSession(): Promise<SessionUser | null> {
  const { user } = await api.auth.me();
  return user;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  initializing: true,
  error: null,

  async initialize() {
    if (!get().initializing) return;
    try {
      const client = await getAuthClient();
      setAuthTokenProvider(async () => null); // Cookie-based auth
      client.onAuthChange((uid) => {
        if (!uid) {
          set({ user: null });
          return;
        }
        void loadSession()
          .then((user) => set({ user }))
          .catch(() => set({ user: null }));
      });
      await client.waitForAuthReady();
      const user = await loadSession();
      set({ user, initializing: false });
    } catch {
      set({ user: null, initializing: false });
    }
  },

  async register({ name, email, password }) {
    try {
      const client = await getAuthClient();
      await client.signUp({ email, password, name });
      const result = await api.auth.register({ name, email, password });
      set({ user: result.user, error: null });
      if (result.accessGranted) {
        useAccessStore.setState({ boundUserId: result.user.id });
      }
      return { ok: true, accessGranted: result.accessGranted };
    } catch (error) {
      set({ error: authErrorMessage(error) });
      return { ok: false, accessGranted: false };
    }
  },

  async login({ email, password }) {
    try {
      const client = await getAuthClient();
      await client.signIn({ email, password });
      const result = await api.auth.login({ email, password });
      set({ user: result.user, error: null });
      if (result.accessGranted) {
        useAccessStore.setState({ boundUserId: result.user.id });
      }
      return { ok: true, accessGranted: result.accessGranted };
    } catch (error) {
      set({ error: authErrorMessage(error) });
      return { ok: false, accessGranted: false };
    }
  },

  async reauthenticate(password) {
    try {
      const client = await getAuthClient();
      await client.reauthenticate(password);
      const result = await api.auth.reauthenticate({ password });
      set({ user: result.user, error: null });
      if (result.accessGranted) {
        useAccessStore.setState({ boundUserId: result.user.id });
      }
      return { ok: true, accessGranted: result.accessGranted };
    } catch (error) {
      set({ error: authErrorMessage(error) });
      return { ok: false, accessGranted: false };
    }
  },

  async logout() {
    await api.auth.logout().catch(() => undefined);
    try {
      const client = await getAuthClient();
      await client.signOut();
    } catch {
      // Session already cleared server side.
    }
    useAccessStore.setState({ boundUserId: null });
    set({ user: null, error: null });
  },

  handleSessionRequired() {
    if (get().user) set({ user: null });
  },
}));

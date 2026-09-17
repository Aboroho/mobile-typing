import { create } from 'zustand';
import type { SessionUser } from '@mt/api-client';
import { api, setAuthTokenProvider } from '@/lib/client/api';
import { emitDevAuthChange, getAuthClient } from '@/lib/client/auth-client';
import { errorMessage } from './access-store';

interface AuthState {
  user: SessionUser | null;
  initializing: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  register: (input: { name: string; email: string; password: string; confirmPassword: string }) => Promise<{ ok: boolean; accessGranted: boolean }>;
  login: (input: { email: string; password: string }) => Promise<{ ok: boolean; accessGranted: boolean }>;
  reauthenticate: (password: string) => Promise<{ ok: boolean; accessGranted: boolean }>;
  logout: () => Promise<void>;
}

/**
 * Authentication state. Which provider is in play (Firebase or the dev
 * provider) is decided by the auth client; this store only orchestrates the
 * resulting API calls and keeps `user` in sync.
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  initializing: true,
  error: null,

  async initialize() {
    if (!get().initializing) return;
    try {
      const client = await getAuthClient();
      setAuthTokenProvider(() => client.getToken());
      client.onAuthChange(() => {
        void api.auth.me().then(({ user }) => set({ user })).catch(() => set({ user: null }));
      });
      const { user } = await api.auth.me();
      set({ user, initializing: false });
      if (client.kind === 'dev') emitDevAuthChange(user?.id ?? null);
    } catch {
      set({ user: null, initializing: false });
    }
  },

  async register({ name, email, password, confirmPassword }) {
    try {
      const client = await getAuthClient();
      if (client.kind === 'firebase') await client.signUp({ email, password, name });
      const result = await api.auth.register({ name, email, password, confirmPassword });
      set({ user: result.user, error: null });
      if (client.kind === 'dev') emitDevAuthChange(result.user.id);
      return { ok: true, accessGranted: result.accessGranted };
    } catch (error) {
      set({ error: errorMessage(error) });
      return { ok: false, accessGranted: false };
    }
  },

  async login({ email, password }) {
    try {
      const client = await getAuthClient();
      if (client.kind === 'firebase') await client.signIn({ email, password });
      const result = await api.auth.login({ email, password });
      set({ user: result.user, error: null });
      if (client.kind === 'dev') emitDevAuthChange(result.user.id);
      return { ok: true, accessGranted: result.accessGranted };
    } catch (error) {
      set({ error: errorMessage(error) });
      return { ok: false, accessGranted: false };
    }
  },

  async reauthenticate(password) {
    try {
      const client = await getAuthClient();
      if (client.kind === 'firebase') await client.reauthenticate(password);
      const result = await api.auth.reauthenticate({ password });
      set({ user: result.user, error: null });
      return { ok: true, accessGranted: result.accessGranted };
    } catch (error) {
      set({ error: errorMessage(error) });
      return { ok: false, accessGranted: false };
    }
  },

  async logout() {
    try {
      const client = await getAuthClient();
      await client.signOut();
    } catch {
      // The API logout below is what actually ends the server session.
    }
    await api.auth.logout().catch(() => undefined);
    emitDevAuthChange(null);
    set({ user: null });
  },
}));

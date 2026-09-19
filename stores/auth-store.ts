import { create } from 'zustand';
import { USER_NAME_MIN_LENGTH } from '@mt/types';
import type { SessionUser } from '@mt/api-client';
import type { LoginFormValues, RegisterFormValues } from '@mt/validation';
import { api, setAuthTokenProvider } from '@/lib/client/api';
import { firebaseAuthMessage, getAuthClient, type AuthClientUser } from '@/lib/client/auth-client';
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
  /** Drops the session when the API reports the credential is no longer valid. */
  handleSessionRequired: () => void;
}

/** Authentication error text: Firebase's codes first, then the API envelope. */
function authErrorMessage(error: unknown): string {
  return firebaseAuthMessage(error) ?? errorMessage(error);
}

/**
 * Display name for a profile that has to be recreated from a Firebase identity
 * alone. Falls back to the email's local part, and to a neutral label when even
 * that is too short for the name schema.
 */
function profileNameFor(user: AuthClientUser): string {
  const displayName = user.displayName?.trim();
  if (displayName && displayName.length >= USER_NAME_MIN_LENGTH) return displayName;
  const localPart = user.email?.split('@')[0]?.trim() ?? '';
  if (localPart.length >= USER_NAME_MIN_LENGTH) return localPart;
  return 'Keypad user';
}

/**
 * Reads the application session, recovering a missing profile on the way.
 *
 * Firebase is the identity provider, so it can outlive the application profile:
 * the browser keeps a signed-in Firebase user while `GET /auth/me` answers
 * `null` because no profile row exists (a first sign-in whose profile write
 * failed, or a profile deleted from the data store). Registration is idempotent
 * for a verified uid, so recreating it is one call — and the alternative is a
 * sign-in loop for somebody whose credentials are perfectly valid.
 */
async function loadSession(): Promise<SessionUser | null> {
  const client = await getAuthClient();
  const { user } = await api.auth.me();
  if (user) return user;

  const current = client.getCurrentUser();
  if (!current) return null;
  try {
    const restored = await api.auth.register({
      name: profileNameFor(current),
      ...(current.email ? { email: current.email } : {}),
    });
    return restored.user;
  } catch {
    // Recovery is a best effort: fall through to the sign-in panel rather than
    // surfacing a second, confusing error on top of a missing profile.
    return null;
  }
}

/**
 * Authentication state.
 *
 * Credentials are handled by the Firebase client SDK (lib/client/auth-client.ts);
 * this store orchestrates the resulting API calls — profile creation, session
 * cookie, access binding — and keeps `user` in sync with the server's answer.
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
      client.onAuthChange((uid) => {
        if (!uid) {
          set({ user: null });
          return;
        }
        void loadSession()
          .then((user) => set({ user }))
          .catch(() => set({ user: null }));
      });
      // Let the SDK restore its persisted session before asking the API, so a
      // reload stays signed in instead of flashing the sign-in panel.
      await client.waitForAuthReady();
      const user = await loadSession();
      set({ user, initializing: false });
    } catch {
      // Firebase is not configured in this browser: the sign-in panel reports
      // exactly which variables are missing when a form is submitted.
      set({ user: null, initializing: false });
    }
  },

  /** `confirmPassword` is checked against `password` by the form schema. */
  async register({ name, email, password }) {
    try {
      const client = await getAuthClient();
      setAuthTokenProvider(() => client.getToken());
      // Firebase creates the account and verifies the password in the browser;
      // the API call that follows only creates the profile and opens the session.
      await client.signUp({ email, password, name });
      const result = await api.auth.register({ name, email });
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
      setAuthTokenProvider(() => client.getToken());
      await client.signIn({ email, password });
      const result = await api.auth.login({ email });
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
      setAuthTokenProvider(() => client.getToken());
      // Resets Firebase's `auth_time`, which is what lets the API re-mint the
      // session cookie and bind the access session to this user.
      await client.reauthenticate(password);
      const result = await api.auth.reauthenticate();
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
    // Server first: it still has the ID token *and* the session cookie, so it can
    // revoke both. Then the browser forgets the Firebase session.
    await api.auth.logout().catch(() => undefined);
    try {
      const client = await getAuthClient();
      await client.signOut();
    } catch {
      // Nothing to sign out of locally; the server session is already gone.
    }
    useAccessStore.setState({ boundUserId: null });
    set({ user: null, error: null });
  },

  handleSessionRequired() {
    if (get().user) set({ user: null });
  },
}));

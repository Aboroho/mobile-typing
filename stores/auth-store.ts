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
async function loadSession(canRecover: () => boolean): Promise<SessionUser | null> {
  const client = await getAuthClient();
  const { user } = await api.auth.me();
  if (user) return user;
  if (!canRecover()) return null;

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
export const useAuthStore = create<AuthState>((set, get) => {
  let initialization: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let sessionVersion = 0;
  let pendingMutations = 0;

  /**
   * Firebase emits auth-state changes before signUp/signIn finish. The explicit
   * action owns profile creation and access binding; an observer must not race
   * it with another registration, a half-updated name, or a stale /auth/me.
   */
  async function authenticate(
    action: () => Promise<{ user: SessionUser; accessGranted: boolean }>,
  ): Promise<AuthActionResult> {
    const version = ++sessionVersion;
    pendingMutations += 1;
    set({ error: null });
    try {
      const result = await action();
      // A logout or a newer action superseded this request.
      if (version !== sessionVersion) return { ok: false, accessGranted: false };
      useAccessStore.getState().bindAuthenticatedUser(result.user.id, result.accessGranted);
      set({ user: result.user, error: null });
      return { ok: true, accessGranted: result.accessGranted };
    } catch (error) {
      if (version === sessionVersion) set({ error: authErrorMessage(error) });
      return { ok: false, accessGranted: false };
    } finally {
      pendingMutations -= 1;
    }
  }

  return {
    user: null,
    initializing: true,
    error: null,

    async initialize() {
      if (!get().initializing) return;
      // React StrictMode mounts effects twice; restore once and subscribe once.
      if (initialization) return initialization;
      const version = sessionVersion;
      initialization = (async () => {
        try {
          const client = await getAuthClient();
          setAuthTokenProvider(() => client.getToken());
          await client.waitForAuthReady();
          let lastUid = client.getCurrentUser()?.uid ?? null;
          unsubscribe?.();
          unsubscribe = client.onAuthChange((uid) => {
            // The initial emission was already handled by waitForAuthReady.
            if (uid === lastUid) return;
            lastUid = uid;
            if (pendingMutations > 0) return;
            const observedVersion = ++sessionVersion;
            if (!uid) {
              useAccessStore.getState().bindAuthenticatedUser(null, false);
              set({ user: null });
              return;
            }
            // A sign-in in another tab can still restore this tab's profile.
            void loadSession(() => observedVersion === sessionVersion && pendingMutations === 0)
              .then((user) => {
                if (observedVersion === sessionVersion) set({ user });
              })
              .catch(() => {
                if (observedVersion === sessionVersion) set({ user: null });
              });
          });
          if (version === sessionVersion && pendingMutations === 0) {
            const user = await loadSession(
              () => version === sessionVersion && pendingMutations === 0,
            );
            if (version === sessionVersion) set({ user });
          }
        } catch {
          // A submitted form reports configuration errors with the exact keys.
          if (version === sessionVersion) set({ user: null });
        } finally {
          set({ initializing: false });
          initialization = null;
        }
      })();
      return initialization;
    },

    /** `confirmPassword` is checked against `password` by the form schema. */
    register({ name, email, password }) {
      return authenticate(async () => {
        const client = await getAuthClient();
        setAuthTokenProvider(() => client.getToken());
        await client.signUp({ email, password, name });
        return api.auth.register({ name, email });
      });
    },

    login({ email, password }) {
      return authenticate(async () => {
        const client = await getAuthClient();
        setAuthTokenProvider(() => client.getToken());
        await client.signIn({ email, password });
        return api.auth.login({ email });
      });
    },

    reauthenticate(password) {
      return authenticate(async () => {
        const client = await getAuthClient();
        setAuthTokenProvider(() => client.getToken());
        // Resets auth_time, allowing the API to re-mint and bind the cookies.
        await client.reauthenticate(password);
        return api.auth.reauthenticate();
      });
    },

    async logout() {
      ++sessionVersion;
      pendingMutations += 1;
      useAccessStore.getState().bindAuthenticatedUser(null, false);
      set({ user: null, error: null });
      try {
        // Server first, while Firebase still holds the credential to revoke.
        await api.auth.logout().catch(() => undefined);
        const client = await getAuthClient();
        await client.signOut();
      } catch {
        // The UI must still sign out if the network/SDK is unavailable.
      } finally {
        pendingMutations -= 1;
      }
    },

    handleSessionRequired() {
      // Foreground actions handle their own errors. Do not let the global 401
      // listener swallow the message from a failed login/registration.
      if (pendingMutations > 0) return;
      ++sessionVersion;
      if (get().user) set({ user: null });
    },
  };
});

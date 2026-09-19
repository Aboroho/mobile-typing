import { parsePublicEnv, hasFirebaseClientConfig, hasPartialFirebaseClientConfig } from '@mt/config';

/** The parts of a Firebase user this application needs, without SDK types. */
export interface AuthClientUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export interface AuthClient {
  /**
   * Bearer credential for API calls: the Firebase ID token, refreshed by the
   * SDK. `null` when nobody is signed in (the session cookie, when this API
   * minted one, travels with the request on its own).
   */
  getToken(): Promise<string | null>;
  /** The signed-in Firebase user, or null. Only valid after `waitForAuthReady`. */
  getCurrentUser(): AuthClientUser | null;
  /**
   * Resolves once the SDK has restored the persisted session, so a reload does
   * not briefly look signed out (and so `getCurrentUser` is trustworthy).
   */
  waitForAuthReady(): Promise<AuthClientUser | null>;
  onAuthChange(callback: (uid: string | null) => void): () => void;
  signUp(input: { email: string; password: string; name: string }): Promise<void>;
  signIn(input: { email: string; password: string }): Promise<void>;
  /** Proves the password is still known; resets Firebase's `auth_time`. */
  reauthenticate(password: string): Promise<void>;
  /** Firebase emails the reset link; this API never sees the password. */
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
}

/** Every variable the browser needs to initialise Firebase. */
const CLIENT_CONFIG_KEYS = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
] as const;

/**
 * Browser authentication, via the Firebase client SDK.
 *
 * There is no fallback provider: without the Firebase web configuration nobody
 * can sign up or sign in, so the failure is reported with the exact variable
 * names instead of being hidden behind a working-looking dev login.
 */
async function createAuthClient(): Promise<AuthClient> {
  const publicEnv = parsePublicEnv();

  if (!hasFirebaseClientConfig(publicEnv)) {
    const missing = hasPartialFirebaseClientConfig(publicEnv)
      ? CLIENT_CONFIG_KEYS.filter((key) => !publicEnv[key])
      : CLIENT_CONFIG_KEYS;
    throw new Error(
      `Firebase Authentication is not configured. Set ${missing.join(', ')} ` +
        '(Firebase console → Project settings → Your apps → SDK setup and configuration), ' +
        'then restart the dev server so the browser bundle picks the values up.',
    );
  }

  const [{ initializeApp, getApps }, auth] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
  ]);
  const app =
    getApps()[0] ??
    initializeApp({
      apiKey: publicEnv.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: publicEnv.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: publicEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: publicEnv.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: publicEnv.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: publicEnv.NEXT_PUBLIC_FIREBASE_APP_ID,
    });
  const firebaseAuth = auth.getAuth(app);
  // When the Auth emulator is requested, point the client SDK at it. This is
  // the browser counterpart to FIREBASE_AUTH_EMULATOR_HOST for the Admin SDK.
  const emulatorHost =
    publicEnv.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ??
    (process.env.FIREBASE_AUTH_EMULATOR_HOST as string | undefined) ??
    (process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST as string | undefined);
  if (emulatorHost) {
    try {
      const url = emulatorHost.startsWith('http') ? emulatorHost : `http://${emulatorHost}`;
      auth.connectAuthEmulator(firebaseAuth, url, { disableWarnings: true });
    } catch {
      // connectAuthEmulator throws if called twice; ignore second call.
    }
  }

  const toClientUser = (user: { uid: string; email: string | null; displayName: string | null } | null) =>
    user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null;

  /**
   * The SDK restores the persisted session asynchronously; this resolves on the
   * first state emission so `initialize()` in the auth store does not race it.
   */
  const ready = new Promise<AuthClientUser | null>((resolve) => {
    const unsubscribe = auth.onAuthStateChanged(firebaseAuth, (user) => {
      unsubscribe();
      resolve(toClientUser(user));
    });
  });

  return {
    async getToken() {
      const user = firebaseAuth.currentUser;
      return user ? user.getIdToken() : null;
    },
    getCurrentUser() {
      return toClientUser(firebaseAuth.currentUser);
    },
    waitForAuthReady() {
      return ready;
    },
    onAuthChange(callback) {
      return auth.onAuthStateChanged(firebaseAuth, (user) => callback(user?.uid ?? null));
    },
    async signUp({ email, password, name }) {
      // A profile request can fail after Firebase has created the account. Reuse
      // that still-authenticated account on retry instead of attempting a second
      // Firebase sign-up (which would only produce auth/email-already-in-use).
      const normalizedEmail = email.trim().toLowerCase();
      const current = firebaseAuth.currentUser;
      const user =
        current && current.email?.trim().toLowerCase() === normalizedEmail
          ? current
          : (await auth.createUserWithEmailAndPassword(firebaseAuth, email, password)).user;
      await auth.updateProfile(user, { displayName: name });
      // Force token acquisition here so registration never races Firebase's
      // auth-state observer: the API client sends this same token as the
      // `Authorization: Bearer` credential on the profile request that follows.
      await user.getIdToken();
    },
    async signIn({ email, password }) {
      await auth.signInWithEmailAndPassword(firebaseAuth, email, password);
    },
    async reauthenticate(password) {
      const user = firebaseAuth.currentUser;
      if (!user?.email) throw new Error('no signed in user');
      await auth.reauthenticateWithCredential(
        user,
        auth.EmailAuthProvider.credential(user.email, password),
      );
    },
    async sendPasswordReset(email) {
      await auth.sendPasswordResetEmail(firebaseAuth, email);
    },
    async signOut() {
      await auth.signOut(firebaseAuth);
    },
  };
}

let clientPromise: Promise<AuthClient> | null = null;

export function getAuthClient(): Promise<AuthClient> {
  if (!clientPromise) clientPromise = createAuthClient();
  return clientPromise;
}

/** Test helper: drop the cached client (used after a test changes the config). */
export function resetAuthClient(): void {
  clientPromise = null;
}

/**
 * Firebase Auth error codes, mapped to messages that are safe to show and that
 * never say whether an account exists: a wrong password, an unknown email and a
 * disabled account all read the same, exactly like the API's 401s.
 */
const FIREBASE_AUTH_MESSAGES: Record<string, string> = {
  'auth/email-already-in-use': 'that email address already has an account',
  'auth/invalid-email': 'enter a valid email address',
  'auth/weak-password': 'that password is too weak',
  'auth/operation-not-allowed': 'email and password sign-in is not enabled for this project',
  'auth/invalid-credential': 'unable to sign in with those details',
  'auth/invalid-login-credentials': 'unable to sign in with those details',
  'auth/wrong-password': 'unable to sign in with those details',
  'auth/user-not-found': 'unable to sign in with those details',
  'auth/user-disabled': 'this account has been disabled',
  'auth/too-many-requests': 'too many attempts, wait a moment and try again',
  'auth/network-request-failed': 'cannot reach Firebase Authentication, check the connection',
  'auth/requires-recent-login': 'sign in again to continue',
  'auth/unauthorized-domain': 'this domain is not authorised in the Firebase Authentication settings',
  'auth/api-key-not-valid': 'the Firebase web configuration is not valid for this project',
  'auth/configuration-not-found': 'email and password sign-in is not enabled for this project',
  'auth/internal-error': 'authentication failed, try again',
};

function firebaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('auth/') ? code : null;
}

/** A message for a Firebase Auth error, or null when it is not one. */
export function firebaseAuthMessage(error: unknown): string | null {
  const code = firebaseErrorCode(error);
  if (!code) return null;
  return FIREBASE_AUTH_MESSAGES[code] ?? `authentication failed (${code.replace('auth/', '')})`;
}

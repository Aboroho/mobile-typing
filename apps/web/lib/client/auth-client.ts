import { parsePublicEnv, hasFirebaseClientConfig } from '@mt/config';

export interface AuthClient {
  readonly kind: 'firebase' | 'dev';
  /** Bearer token for API calls, or null when the session lives in a cookie. */
  getToken(): Promise<string | null>;
  onAuthChange(callback: (uid: string | null) => void): () => void;
  signUp(input: { email: string; password: string; name: string }): Promise<void>;
  signIn(input: { email: string; password: string }): Promise<void>;
  /** Firebase reauthentication; a no-op for the dev provider (the API checks). */
  reauthenticate(password: string): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * Browser auth adapter. With Firebase configured it uses the client SDK so
 * passwords never reach our API; without it, the dev provider relies on the
 * httpOnly session cookie set by `/api/v1/auth/*`.
 */
async function createAuthClient(): Promise<AuthClient> {
  const publicEnv = parsePublicEnv();

  if (hasFirebaseClientConfig(publicEnv)) {
    const [{ initializeApp, getApps }, { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, reauthenticateWithCredential, EmailAuthProvider, updateProfile: fbUpdateProfile, signOut: fbSignOut }] =
      await Promise.all([import('firebase/app'), import('firebase/auth')]);
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
    const auth = getAuth(app);

    return {
      kind: 'firebase',
      async getToken() {
        const user = auth.currentUser;
        return user ? user.getIdToken() : null;
      },
      onAuthChange(callback) {
        return onAuthStateChanged(auth, (user) => callback(user?.uid ?? null));
      },
      async signUp({ email, password, name }) {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await fbUpdateProfile(credential.user, { displayName: name });
      },
      async signIn({ email, password }) {
        await signInWithEmailAndPassword(auth, email, password);
      },
      async reauthenticate(password) {
        const user = auth.currentUser;
        if (!user?.email) throw new Error('no signed in user');
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      },
      async signOut() {
        await fbSignOut(auth);
      },
    };
  }

  return {
    kind: 'dev',
    async getToken() {
      return null;
    },
    onAuthChange(callback) {
      const handler = (event: Event) => callback((event as CustomEvent<string | null>).detail);
      globalThis.addEventListener('mt:dev-auth', handler);
      return () => globalThis.removeEventListener('mt:dev-auth', handler);
    },
    async signUp() {
      // Handled by the API call in the auth store.
    },
    async signIn() {
      // Handled by the API call in the auth store.
    },
    async reauthenticate() {
      // Handled by the API call in the auth store.
    },
    async signOut() {
      // Handled by the API call in the auth store.
    },
  };
}

let clientPromise: Promise<AuthClient> | null = null;

export function getAuthClient(): Promise<AuthClient> {
  if (!clientPromise) clientPromise = createAuthClient();
  return clientPromise;
}

/** Dev provider: notify listeners that the session identity changed. */
export function emitDevAuthChange(uid: string | null): void {
  globalThis.dispatchEvent(new CustomEvent('mt:dev-auth', { detail: uid }));
}

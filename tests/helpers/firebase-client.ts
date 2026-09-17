/**
 * An in-process double for the Firebase **client** SDK (`firebase/app` and
 * `firebase/auth`), for tests that exercise the browser half of authentication.
 *
 * It keeps the semantics the application depends on: an account is created once
 * per email, a wrong password and an unknown email fail the same way,
 * `updateProfile` sets the display name, `getIdToken` hands out a bearer
 * credential, and `onAuthStateChanged` reports the persisted user
 * asynchronously — exactly like the real SDK restoring a session on load.
 */

export class FakeFirebaseAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Firebase: Error (${code}).`);
    this.name = 'FirebaseError';
    this.code = code;
  }
}

export interface FakeClientUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  getIdToken(): Promise<string>;
}

interface Account {
  uid: string;
  email: string;
  password: string;
  displayName: string | null;
}

export class FakeFirebaseClientAuth {
  private accounts = new Map<string, Account>();
  private listeners = new Set<(user: FakeClientUser | null) => void>();
  private currentUid: string | null = null;
  /** Emails a reset mail was "sent" to. */
  readonly resetEmails: string[] = [];

  reset(): void {
    this.accounts.clear();
    this.listeners.clear();
    this.resetEmails.length = 0;
    this.currentUid = null;
  }

  get currentUser(): FakeClientUser | null {
    return this.currentUid ? this.toUser(this.accounts.get(this.currentUid)) : null;
  }

  /** A signed-in user without going through the password flow (a reload). */
  restoreSession(uid: string): void {
    if (!this.accounts.has(uid)) throw new Error(`no such account: ${uid}`);
    this.currentUid = uid;
    this.emit();
  }

  async createUser(email: string, password: string): Promise<FakeClientUser> {
    const normalized = email.trim().toLowerCase();
    for (const account of this.accounts.values()) {
      if (account.email === normalized) throw new FakeFirebaseAuthError('auth/email-already-in-use');
    }
    if (password.length < 6) throw new FakeFirebaseAuthError('auth/weak-password');
    const uid = `web_${normalized.replace(/[^a-z0-9]/g, '')}`;
    this.accounts.set(uid, { uid, email: normalized, password, displayName: null });
    this.currentUid = uid;
    this.emit();
    return this.toUser(this.accounts.get(uid));
  }

  async signIn(email: string, password: string): Promise<FakeClientUser> {
    const normalized = email.trim().toLowerCase();
    const account = [...this.accounts.values()].find((candidate) => candidate.email === normalized);
    if (!account || account.password !== password) {
      throw new FakeFirebaseAuthError('auth/invalid-login-credentials');
    }
    this.currentUid = account.uid;
    this.emit();
    return this.toUser(account);
  }

  async reauthenticate(uid: string, password: string): Promise<void> {
    const account = this.accounts.get(uid);
    if (!account || account.password !== password) {
      throw new FakeFirebaseAuthError('auth/invalid-credential');
    }
  }

  updateProfile(uid: string, displayName: string): void {
    const account = this.accounts.get(uid);
    if (account) account.displayName = displayName;
  }

  async sendPasswordReset(email: string): Promise<void> {
    this.resetEmails.push(email.trim().toLowerCase());
  }

  async signOut(): Promise<void> {
    this.currentUid = null;
    this.emit();
  }

  /** The real SDK calls back asynchronously, with the persisted user. */
  onAuthStateChanged(callback: (user: FakeClientUser | null) => void): () => void {
    this.listeners.add(callback);
    setTimeout(() => callback(this.currentUser), 0);
    return () => this.listeners.delete(callback);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.currentUser);
  }

  private toUser(account: Account | undefined): FakeClientUser {
    if (!account) throw new FakeFirebaseAuthError('auth/user-not-found');
    return {
      uid: account.uid,
      email: account.email,
      displayName: account.displayName,
      // The shape the API verifies: an opaque bearer credential naming the uid.
      getIdToken: async () => `id-token-${account.uid}`,
    };
  }
}

/** One instance per worker, however the module is imported. */
const shared = globalThis as { __mtFakeFirebaseClientAuth?: FakeFirebaseClientAuth };
export const fakeFirebaseClientAuth: FakeFirebaseClientAuth =
  shared.__mtFakeFirebaseClientAuth ??
  (shared.__mtFakeFirebaseClientAuth = new FakeFirebaseClientAuth());

export function resetFirebaseClientAuth(): void {
  fakeFirebaseClientAuth.reset();
}

/** Shaped like `firebase/app`. */
export const firebaseAppModule = {
  initializeApp: (config: Record<string, unknown>) => ({ name: '[DEFAULT]', options: config }),
  getApps: () => [],
};

/** Shaped like `firebase/auth`: free functions taking the auth instance first. */
export const firebaseAuthModule = {
  getAuth: () => fakeFirebaseClientAuth,
  onAuthStateChanged: (
    _auth: unknown,
    callback: (user: FakeClientUser | null) => void,
  ) => fakeFirebaseClientAuth.onAuthStateChanged(callback),
  createUserWithEmailAndPassword: async (_auth: unknown, email: string, password: string) => ({
    user: await fakeFirebaseClientAuth.createUser(email, password),
  }),
  signInWithEmailAndPassword: async (_auth: unknown, email: string, password: string) => ({
    user: await fakeFirebaseClientAuth.signIn(email, password),
  }),
  updateProfile: async (user: FakeClientUser, profile: { displayName?: string }) => {
    if (profile.displayName !== undefined) {
      fakeFirebaseClientAuth.updateProfile(user.uid, profile.displayName);
    }
  },
  reauthenticateWithCredential: async (user: FakeClientUser, credential: { password: string }) => {
    await fakeFirebaseClientAuth.reauthenticate(user.uid, credential.password);
  },
  EmailAuthProvider: {
    credential: (email: string, password: string) => ({ email, password }),
  },
  sendPasswordResetEmail: async (_auth: unknown, email: string) => {
    await fakeFirebaseClientAuth.sendPasswordReset(email);
  },
  signOut: async () => {
    await fakeFirebaseClientAuth.signOut();
  },
};

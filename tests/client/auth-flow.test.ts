/**
 * @vitest-environment jsdom
 *
 * The browser half of authentication.
 *
 * Firebase's client SDK is replaced by an in-memory double
 * (`tests/helpers/firebase-client.ts`) — it has no offline mode — and `fetch` is
 * answered by a stub that records exactly what the browser sent. That is what
 * makes these tests worth having: they prove the credential goes to Firebase,
 * that a password is never posted to this application's own API, and that the
 * store ends up with the profile the server returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAuthClient, getAuthClient, firebaseAuthMessage } from '@/lib/client/auth-client';
import { useAuthStore } from '@/stores/auth-store';
import { useAccessStore } from '@/stores/access-store';
import { fakeFirebaseClientAuth, resetFirebaseClientAuth } from '../helpers/firebase-client';

vi.mock('firebase/app', async () => (await import('../helpers/firebase-client')).firebaseAppModule);
vi.mock(
  'firebase/auth',
  async () => (await import('../helpers/firebase-client')).firebaseAuthModule,
);

interface Profile {
  id: string;
  name: string;
  email: string;
  photoUrl: null;
  status: 'active';
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface Recorded {
  path: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/**
 * Stands in for `/api/v1/auth/*`. The bearer token is the identity, exactly as
 * the real route treats a verified Firebase ID token.
 */
function installApiStub() {
  const profiles = new Map<string, Profile>();
  const requests: Recorded[] = [];

  const respond = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const uidFrom = (authorization: string | null) =>
    authorization?.startsWith('Bearer id-token-')
      ? authorization.slice('Bearer id-token-'.length)
      : null;

  const profileFor = (uid: string, name: string, email: string): Profile => {
    const existing = profiles.get(uid);
    if (existing) return existing;
    const created: Profile = {
      id: uid,
      name,
      email,
      photoUrl: null,
      status: 'active',
      isAdmin: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    profiles.set(uid, created);
    return created;
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path: url.pathname, method: init?.method ?? 'GET', authorization, body });

      const uid = uidFrom(authorization);
      const email = String(body['email'] ?? '');

      if (url.pathname === '/api/v1/auth/me') {
        const profile = uid ? profiles.get(uid) : undefined;
        return respond(200, { ok: true, data: { user: profile ?? null } });
      }
      if (url.pathname === '/api/v1/auth/register') {
        if (!uid) {
          return respond(401, {
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'complete the Firebase sign-up first' },
          });
        }
        const profile = profileFor(
          uid,
          String(body['name'] ?? 'User'),
          email || `${uid}@example.com`,
        );
        return respond(201, {
          ok: true,
          data: { user: profile, token: null, cookieSession: true, accessGranted: true },
        });
      }
      if (url.pathname === '/api/v1/auth/login') {
        if (!uid) {
          return respond(401, {
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'unable to sign in with those details' },
          });
        }
        const profile = profileFor(uid, 'Alice', email || `${uid}@example.com`);
        return respond(200, {
          ok: true,
          data: { user: profile, token: null, cookieSession: true, accessGranted: true },
        });
      }
      if (url.pathname === '/api/v1/auth/reauthenticate') {
        if (!uid) {
          return respond(401, {
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'sign in again' },
          });
        }
        return respond(200, {
          ok: true,
          data: { user: profiles.get(uid) ?? null, accessGranted: true },
        });
      }
      if (url.pathname === '/api/v1/auth/logout') {
        return respond(200, { ok: true, data: { loggedOut: true } });
      }
      return respond(404, { ok: false, error: { code: 'NOT_FOUND', message: url.pathname } });
    }),
  );

  return {
    requests,
    profiles,
    dropProfile(uid: string) {
      profiles.delete(uid);
    },
    requestFor(path: string) {
      return requests.find((request) => request.path === path);
    },
  };
}

type ApiStub = ReturnType<typeof installApiStub>;

let api: ApiStub;

beforeEach(() => {
  resetFirebaseClientAuth();
  resetAuthClient();
  api = installApiStub();
  useAccessStore.setState({ unlocked: false, boundUserId: null });
  useAuthStore.setState({ user: null, initializing: true, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAuthClient();
});

const credentials = {
  name: 'Alice',
  email: 'alice@example.com',
  password: 'CorrectHorse1!',
  confirmPassword: 'CorrectHorse1!',
};

describe('registration in the browser', () => {
  it('creates the Firebase account, sets the display name and opens the session', async () => {
    const result = await useAuthStore.getState().register(credentials);

    expect(result).toEqual({ ok: true, accessGranted: true });
    expect(useAuthStore.getState().user?.id).toBe('web_aliceexamplecom');
    expect(useAuthStore.getState().error).toBeNull();
    // Firebase holds the display name, so the profile can be recreated from it.
    expect(fakeFirebaseClientAuth.currentUser?.displayName).toBe('Alice');
  });

  it('sends the ID token, and never a password, to this application', async () => {
    await useAuthStore.getState().register(credentials);

    const register = api.requestFor('/api/v1/auth/register');
    expect(register?.authorization).toBe('Bearer id-token-web_aliceexamplecom');
    expect(register?.body).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
    expect(Object.keys(register?.body ?? {})).not.toContain('password');
    expect(Object.keys(register?.body ?? {})).not.toContain('confirmPassword');
    // The password went to Firebase only.
    expect(
      api.requests.filter((request) => JSON.stringify(request.body).includes('CorrectHorse1!')),
    ).toEqual([]);
  });

  it('reports a duplicate email without saying which side refused it', async () => {
    await useAuthStore.getState().register(credentials);
    // A different visitor on the same browser: signed out, so Firebase really is
    // asked to create the account again.
    await useAuthStore.getState().logout();
    useAuthStore.setState({ error: null });

    const second = await useAuthStore.getState().register(credentials);
    expect(second.ok).toBe(false);
    expect(useAuthStore.getState().error).toBe('that email address already has an account');
    // The refusal came from Firebase, so no profile request was made for it.
    expect(api.requests.filter((request) => request.path === '/api/v1/auth/register')).toHaveLength(
      1,
    );
  });

  it('reuses the signed-in Firebase account when a profile request is retried', async () => {
    // The other half of the same rule: a retry after a failed profile write must
    // not attempt a second Firebase sign-up (which could only fail).
    await useAuthStore.getState().register(credentials);
    api.requests.length = 0;

    const retry = await useAuthStore.getState().register(credentials);
    expect(retry.ok).toBe(true);
    expect(api.requestFor('/api/v1/auth/register')?.body).toMatchObject({ name: 'Alice' });
  });
});

describe('login in the browser', () => {
  it('signs in with Firebase and loads the profile', async () => {
    await useAuthStore.getState().register(credentials);
    await useAuthStore.getState().logout();
    useAuthStore.setState({ error: null });

    const result = await useAuthStore
      .getState()
      .login({ email: credentials.email, password: credentials.password });
    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().user?.email).toBe('alice@example.com');

    const login = api.requestFor('/api/v1/auth/login');
    expect(login?.authorization).toBe('Bearer id-token-web_aliceexamplecom');
    expect(Object.keys(login?.body ?? {})).not.toContain('password');
  });

  it('stops at Firebase when the password is wrong, and says nothing about accounts', async () => {
    await useAuthStore.getState().register(credentials);
    useAuthStore.setState({ error: null, user: null });

    const wrongPassword = await useAuthStore
      .getState()
      .login({ email: credentials.email, password: 'WrongPassword1!' });
    const unknownEmail = await useAuthStore
      .getState()
      .login({ email: 'nobody@example.com', password: 'WrongPassword1!' });

    expect(wrongPassword.ok).toBe(false);
    expect(unknownEmail.ok).toBe(false);
    expect(useAuthStore.getState().error).toBe('unable to sign in with those details');
    // Neither attempt reached the API: Firebase refused both first.
    expect(api.requests.filter((request) => request.path === '/api/v1/auth/login')).toHaveLength(0);
  });
});

describe('logout in the browser', () => {
  it('ends the server session and the Firebase session', async () => {
    await useAuthStore.getState().register(credentials);
    expect(fakeFirebaseClientAuth.currentUser).not.toBeNull();

    await useAuthStore.getState().logout();

    expect(api.requestFor('/api/v1/auth/logout')).toBeTruthy();
    expect(fakeFirebaseClientAuth.currentUser).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('still clears the local session when the API cannot be reached', async () => {
    await useAuthStore.getState().register(credentials);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await useAuthStore.getState().logout();

    expect(fakeFirebaseClientAuth.currentUser).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe('session persistence and recovery', () => {
  it('restores a signed-in browser on load, waiting for Firebase first', async () => {
    await fakeFirebaseClientAuth.createUser(credentials.email, credentials.password);
    const uid = fakeFirebaseClientAuth.currentUser?.uid ?? '';
    api.profiles.set(uid, {
      id: uid,
      name: 'Alice',
      email: credentials.email,
      photoUrl: null,
      status: 'active',
      isAdmin: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().initializing).toBe(false);
    expect(useAuthStore.getState().user?.id).toBe(uid);
    // The request carried the persisted credential, not a stored password.
    expect(api.requestFor('/api/v1/auth/me')?.authorization).toBe(`Bearer id-token-${uid}`);
  });

  it('recreates a profile that is missing while Firebase still has the user', async () => {
    await useAuthStore.getState().register(credentials);
    const uid = useAuthStore.getState().user?.id ?? '';
    api.dropProfile(uid);
    useAuthStore.setState({ user: null, initializing: true });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().user?.id).toBe(uid);
    // Recovery went through registration, with the display name Firebase holds.
    const recovery = api.requests.filter((request) => request.path === '/api/v1/auth/register');
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery[recovery.length - 1]?.body).toMatchObject({
      name: 'Alice',
      email: 'alice@example.com',
    });
  });

  it('stays signed out when Firebase has nobody', async () => {
    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().initializing).toBe(false);
  });
});

describe('reauthentication and password reset', () => {
  it('re-proves the password with Firebase before binding the session', async () => {
    await useAuthStore.getState().register(credentials);

    const result = await useAuthStore.getState().reauthenticate(credentials.password);
    expect(result.ok).toBe(true);
    expect(api.requestFor('/api/v1/auth/reauthenticate')?.authorization).toBe(
      'Bearer id-token-web_aliceexamplecom',
    );
    // The password is checked by Firebase, so the API body carries nothing.
    expect(api.requestFor('/api/v1/auth/reauthenticate')?.body).toEqual({});

    const wrong = await useAuthStore.getState().reauthenticate('WrongPassword1!');
    expect(wrong.ok).toBe(false);
    expect(useAuthStore.getState().error).toBe('unable to sign in with those details');
  });

  it('asks Firebase to send the reset email instead of this API', async () => {
    const client = await getAuthClient();
    await client.sendPasswordReset('alice@example.com');

    expect(fakeFirebaseClientAuth.resetEmails).toEqual(['alice@example.com']);
    expect(api.requests.filter((request) => request.path.includes('password-reset'))).toEqual([]);
  });
});

describe('configuration and error reporting', () => {
  it('refuses to start without the Firebase web configuration, naming the variables', async () => {
    const keys = [
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
    ];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    for (const key of keys) delete process.env[key];
    resetAuthClient();

    try {
      await expect(getAuthClient()).rejects.toThrow(/NEXT_PUBLIC_FIREBASE_API_KEY/);
      // The sign-in panel shows that, so an operator sees the fix, not a 401.
      const result = await useAuthStore.getState().login({
        email: credentials.email,
        password: credentials.password,
      });
      expect(result.ok).toBe(false);
      expect(useAuthStore.getState().error).toContain('NEXT_PUBLIC_FIREBASE_APP_ID');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetAuthClient();
    }
  });

  it('turns Firebase error codes into messages that are safe to show', () => {
    expect(firebaseAuthMessage({ code: 'auth/email-already-in-use' })).toBe(
      'that email address already has an account',
    );
    // A wrong password and an unknown email read the same.
    expect(firebaseAuthMessage({ code: 'auth/wrong-password' })).toBe(
      firebaseAuthMessage({ code: 'auth/user-not-found' }),
    );
    expect(firebaseAuthMessage(new Error('something else'))).toBeNull();
  });
});

#!/usr/bin/env node
/**
 * Seeds a *running* server with two demo accounts (administrator + peer) and
 * prints the value to put in ADMIN_UID.
 *
 * It talks to the dev server (default http://localhost:3000) through the public
 * API, so it exercises exactly the same code path as the browser: accounts are
 * created in Firebase Authentication through the Identity Toolkit REST API with
 * NEXT_PUBLIC_FIREBASE_API_KEY (the same call the browser SDK makes), and the
 * resulting ID token is presented as a bearer token. A password is never sent to
 * the Keypad API, exactly as in the browser.
 *
 * Configuration comes from the environment — the same keys the application
 * itself uses — never from hard-coded defaults in this file:
 *
 *   ADMIN_EMAIL        administrator account email        (required)
 *   ADMIN_PASSWORD     administrator account password     (required, >= 8 chars)
 *   SEED_PEER_EMAIL    peer account email                 (default peer@example.com)
 *   SEED_PEER_PASSWORD peer account password              (default ADMIN_PASSWORD)
 *   SEED_SECRET_CODE   access code used to unlock the gate (falls back to the
 *                      code the challenge hands out)
 *   BASE_URL           server to talk to                  (default http://localhost:3000)
 *   FIREBASE_IDENTITY_BASE_URL  Identity Toolkit endpoint (default Google's; point
 *                      it at the Auth emulator, e.g. http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1)
 *
 * Values are read from the process environment first, then from `.env.local`,
 * then from `.env` — the same precedence Next.js uses for those files.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const PASSWORD_MIN_LENGTH = 8;
const FIREBASE_IDENTITY_BASE =
  process.env.FIREBASE_IDENTITY_BASE_URL ?? 'https://identitytoolkit.googleapis.com/v1';

/**
 * Minimal `.env` loader so `npm run seed` sees the same values as the dev
 * server without an extra dependency. Existing process env entries always win.
 */
function loadEnvFile(file) {
  let contents;
  try {
    contents = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return; // Missing file is fine — .env.local is optional.
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
const PEER_EMAIL = process.env.SEED_PEER_EMAIL ?? 'peer@example.com';
const PEER_PASSWORD = process.env.SEED_PEER_PASSWORD ?? ADMIN_PASSWORD;
const SECRET_CODE = process.env.SEED_SECRET_CODE;
const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!ADMIN_EMAIL)
  fail(
    'Set ADMIN_EMAIL in the environment or .env.local — the seed refuses to guess the administrator account.',
  );
if (!ADMIN_PASSWORD)
  fail(
    'Set ADMIN_PASSWORD in the environment or .env.local — the seed refuses to guess the administrator password.',
  );
if (ADMIN_PASSWORD.length < PASSWORD_MIN_LENGTH) {
  fail(`ADMIN_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters.`);
}

/** Calls the API, attaching an access cookie and/or bearer token. */
async function api(path, options = {}) {
  const { method = 'POST', body, cookie, token } = options;
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(
      `${path} failed (${response.status}): ${JSON.stringify(payload.error ?? payload)}`,
    );
    error.status = response.status;
    error.code = payload?.error?.code ?? null;
    error.context = payload?.error?.context ?? null;
    throw error;
  }
  return { payload: payload.data, cookies: response.headers.getSetCookie?.() ?? [] };
}

const post = (path, body, options = {}) => api(path, { ...options, body });

function cookieHeader(cookies) {
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

/**
 * Completes the access flow. The digest is computed from SEED_SECRET_CODE so
 * the unlock uses exactly the code configured in the environment; only if that
 * code is rejected (an administrator already rotated it in /admin/settings) do
 * we fall back to the code the dev challenge exposes.
 *
 * Every attempt needs its own challenge: challenge tokens are single-use, so a
 * rejected unlock burns the token it was sent with.
 */
async function unlockAccess() {
  const codes = SECRET_CODE
    ? [
        [SECRET_CODE, 'SEED_SECRET_CODE'],
        [null, 'challenge'],
      ]
    : [[null, 'challenge']];

  for (const [code, source] of codes) {
    const { payload: challengePayload, cookies } = await post('/api/v1/access/challenge', {});
    const accessCookie = cookieHeader(cookies);
    const effectiveCode = code ?? challengePayload.challenge.code;
    let unlocked = false;
    let sessionCookies = [];
    try {
      const unlock = await post(
        '/api/v1/access/unlock',
        {
          challengeToken: challengePayload.challenge.challengeToken,
          digest: sha256(effectiveCode),
        },
        { cookie: accessCookie },
      );
      unlocked = Boolean(unlock.payload.unlocked);
      sessionCookies = unlock.cookies;
    } catch {
      // PRECONDITION_FAILED from a wrong code — try the next candidate.
    }
    if (unlocked) {
      if (source === 'challenge' && SECRET_CODE) {
        console.log(
          'note: SEED_SECRET_CODE did not match — unlocked with the code returned by the challenge (the code was probably rotated).',
        );
      }
      return cookieHeader(sessionCookies);
    }
  }
  throw new Error(
    'access unlock failed: neither SEED_SECRET_CODE nor the challenge code was accepted',
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Calls the Identity Toolkit REST API — the same service the browser's
 * `createUserWithEmailAndPassword` / `signInWithEmailAndPassword` call. The Web
 * API key is public by design (`NEXT_PUBLIC_FIREBASE_API_KEY`), so this adds no
 * new secret to the environment.
 */
async function firebaseIdentity(operation, body) {
  const url = `${FIREBASE_IDENTITY_BASE}/${operation}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, returnSecureToken: true }),
    });
  } catch (cause) {
    const error = new Error(
      `could not reach Firebase Identity Toolkit at ${FIREBASE_IDENTITY_BASE} ` +
        `(${cause.cause?.code ?? cause.message}). Check this machine can reach googleapis.com, ` +
        'or set FIREBASE_IDENTITY_BASE_URL to the Auth emulator endpoint.',
    );
    error.cause = cause;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload?.error?.message ?? `HTTP ${response.status}`;
    const error = new Error(`Firebase ${operation} failed: ${reason}`);
    error.code = reason;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** Returns an ID token for the account, creating it in Firebase Auth if needed. */
async function firebaseSession(email, password) {
  let created = null;
  try {
    created = await firebaseIdentity('accounts:signUp', { email, password });
  } catch (error) {
    if (!String(error.code).startsWith('EMAIL_EXISTS')) throw error;
  }
  if (created) return { idToken: created.idToken, existed: false };

  // The Firebase account already exists: sign in the way the browser SDK would.
  try {
    const signedIn = await firebaseIdentity('accounts:signInWithPassword', {
      email,
      password,
    });
    return { idToken: signedIn.idToken, existed: true };
  } catch (error) {
    if (String(error.code).startsWith('INVALID_LOGIN_CREDENTIALS')) {
      throw new Error(
        `a Firebase account with ${email} already exists but its password is not ADMIN_PASSWORD / SEED_PEER_PASSWORD. ` +
          'Reset that user in the Firebase console (or delete it) and run the seed again.',
      );
    }
    throw error;
  }
}

/** A profile whose name is the email local part was auto-created from /login. */
function wasAutoNamed(user, email) {
  return user.name === email.split('@')[0];
}

/**
 * Registers one account.
 *
 * The Identity Toolkit call says whether the Firebase account is new, which
 * matters because `/api/v1/auth/register` is rate limited to five calls per ten
 * minutes per IP: an account that already exists is signed in instead of being
 * registered again on every run.
 */
async function seedAccount(account, accessCookie) {
  const options = { cookie: accessCookie };
  const session = await firebaseSession(account.email, account.password);
  options.token = session.idToken;

  if (session.existed) {
    const { payload } = await post('/api/v1/auth/login', { email: account.email }, options);
    const repaired = await repairName(payload.user, account, accessCookie, options.token);
    return { status: 'exists', user: repaired };
  }
  const { payload } = await post(
    '/api/v1/auth/register',
    { name: account.name, email: account.email },
    options,
  );
  return { status: 'created', user: payload.user };
}

/** Gives an auto-created profile the display name the seed asked for. */
async function repairName(user, account, accessCookie, token) {
  if (!wasAutoNamed(user, account.email)) return user;
  const { payload } = await api('/api/v1/auth/profile', {
    method: 'PATCH',
    body: { name: account.name },
    cookie: accessCookie,
    token,
  });
  return payload.user;
}

/** Extra guidance for the two failures that are easy to misread. */
function failureHelp(error) {
  if (error.status === 429) {
    const seconds = Number(error.context?.retryAfterSeconds);
    const retry = Number.isFinite(seconds)
      ? ` — retry in about ${Math.ceil(seconds / 60)} minute(s)`
      : '';
    return (
      `\nThe server's auth rate limit rejected this call${retry}. Re-running the seed after a short\n` +
      'pause is fine; with the default memory provider, restarting the dev server clears the counters\n' +
      '(and the seeded accounts with them).'
    );
  }
  const reason = String(error.code ?? error.message);
  if (/referer|referrer|blocked|not authorized|PERMISSION_DENIED|API_KEY/i.test(reason)) {
    return (
      '\nThe Web API key was rejected for a non-browser caller. In Google Cloud Console → APIs & Services\n' +
      '→ Credentials, relax the key restrictions (or use the unrestricted key) for local seeding, keep\n' +
      'Identity Toolkit enabled, and run the seed again.'
    );
  }
  return '';
}

async function main() {
  let health;
  try {
    health = await fetch(`${BASE_URL}/api/v1/health`).then((response) => {
      if (!response.ok) throw new Error(`health returned ${response.status}`);
      return response.json();
    });
  } catch (error) {
    fail(
      `could not reach ${BASE_URL}/api/v1/health (${error.message}).\n` +
        'Start the dev server first (`npm run dev`) — the seed registers through the running API.',
    );
  }

  const authProvider = health.data?.authProvider ?? 'firebase';
  console.log(`server: ${BASE_URL} — data: ${health.data?.dataProvider}, auth: ${authProvider}`);

  if (!FIREBASE_API_KEY) {
    fail(
      'Registration needs a Firebase ID token, which only the Identity Toolkit can issue — a password\n' +
        'alone is not enough (that is the "complete the Firebase sign-up first" error). Set\n' +
        'NEXT_PUBLIC_FIREBASE_API_KEY (the Web API key of the same project) in .env.local and re-run.',
    );
  }

  // The access flow must be completed before registering, exactly like a browser.
  const accessCookie = await unlockAccess();

  const accounts = [
    { email: ADMIN_EMAIL, name: 'Administrator', password: ADMIN_PASSWORD },
    { email: PEER_EMAIL, name: 'Peer User', password: PEER_PASSWORD },
  ];

  let adminUid = null;
  const failures = [];

  for (const account of accounts) {
    try {
      const { status, user } = await seedAccount(account, accessCookie);
      if (account.email === ADMIN_EMAIL) adminUid = user.id;
      console.log(
        `${status === 'created' ? 'created' : 'already present'} ${account.email} -> uid ${user.id}` +
          `${user.isAdmin ? ' (ADMIN)' : ''}`,
      );
    } catch (error) {
      failures.push(account.email);
      console.error(`failed ${account.email}: ${error.message}${failureHelp(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} of ${accounts.length} account(s) could not be seeded: ${failures.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nAdministrator identity comes from the environment (ADMIN_UID / ADMIN_EMAIL).');
  if (adminUid) {
    console.log(
      'ADMIN_EMAIL is set, so the administrator resolves already. To pin it by uid instead,',
    );
    console.log('add this to .env.local and restart the dev server:');
    console.log(`  ADMIN_UID=${adminUid}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

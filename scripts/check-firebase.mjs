#!/usr/bin/env node
/**
 * Verifies that this machine can actually use the Firebase project the
 * environment points at, instead of letting you find out through a failed
 * request in the browser.
 *
 *   npm run doctor                  full check
 *   npm run doctor -- --no-signup   skip the Firebase Auth sign-up probe
 *   npm run doctor -- --no-server   skip the comparison with a running dev server
 *   npm run doctor -- --base-url http://localhost:3000
 *                                   compare against a specific dev server
 *
 * What it does to your project: three probes, each deleted again — one Firestore
 * document (`mtDoctorProbes/probe`), one Storage object
 * (`media/__doctor_probe__.txt`) and, unless `--no-signup` is given, one
 * Firebase Auth user created through the same Identity Toolkit call the browser
 * SDK makes (which is the only way to find out whether the Email/Password
 * provider is enabled). Nothing else is written.
 *
 * No secret is printed: values are reported as the file they came from plus a
 * length, so the output is safe to paste into an issue.
 *
 * Environment resolution mirrors Next.js — the process environment wins, then
 * `.env.$NODE_ENV.local`, `.env.local`, `.env.$NODE_ENV`, `.env` — and reports
 * which file each value came from, because a blank key in a higher-precedence
 * file silently overrides the real one below it.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const NO_SIGNUP = args.includes('--no-signup');

function flagValue(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const BASE_URL = args.includes('--no-server') ? undefined : flagValue('--base-url', 'http://localhost:3000');

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const ENV_FILES = [
  `.env.${NODE_ENV}.local`,
  '.env.local',
  ...(NODE_ENV === 'test' ? [] : [`.env.${NODE_ENV}`, '.env']),
];

const CLIENT_KEYS = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
];
const ADMIN_KEYS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
const PROVIDER_KEYS = ['DATA_PROVIDER', 'STORAGE_PROVIDER'];
const STORAGE_KEY = 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET';
const ALL_KEYS = [
  ...PROVIDER_KEYS,
  ...CLIENT_KEYS,
  STORAGE_KEY,
  ...ADMIN_KEYS,
  'ADMIN_UID',
  'ADMIN_EMAIL',
  'SEED_SECRET_CODE',
];

/** Keys whose value must never appear in the output, not even in part. */
const SECRET_KEYS = new Set([
  'FIREBASE_PRIVATE_KEY',
  'APP_SECRET',
  'ADMIN_PASSWORD',
  'SEED_SECRET_CODE',
  'TURN_SERVER_CREDENTIAL',
]);

const OK = ' ok ';
const FAIL = 'FAIL';
const WARN = 'warn';
const SKIP = 'skip';

const results = [];

function record(status, name, detail, hint) {
  results.push({ status, name, detail, hint });
  const line = `[${status}] ${name}${detail ? ` — ${detail}` : ''}`;
  if (status === FAIL) console.error(line);
  else console.log(line);
  if (hint && status !== OK) console.log(`        ${hint}`);
}

const ok = (name, detail) => record(OK, name, detail);
const fail = (name, detail, hint) => record(FAIL, name, detail, hint);
const warn = (name, detail, hint) => record(WARN, name, detail, hint);
const skip = (name, detail) => record(SKIP, name, detail);

/** Seconds any single network probe may take before it is reported as a failure. */
const PROBE_TIMEOUT_SECONDS = 30;

/**
 * The Firebase SDKs retry for minutes when the backend is unreachable, which
 * would leave a diagnostic hanging with no output. Every probe is therefore
 * raced against a deadline; `process.exit` at the end drops whatever is still
 * pending.
 */
async function withTimeout(label, work) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${PROBE_TIMEOUT_SECONDS}s`)),
          PROBE_TIMEOUT_SECONDS * 1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// --- environment -----------------------------------------------------------

function parseEnvFile(file) {
  let contents;
  try {
    contents = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return null; // Absent files are normal: only .env.local, or only .env.
  }
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return { file, values };
}

const files = ENV_FILES.map(parseEnvFile).filter(Boolean);

/** key -> { value, source }, highest precedence first. */
const resolved = new Map();
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) resolved.set(key, { value, source: 'process env' });
}
for (const parsed of files) {
  for (const [key, value] of parsed.values) {
    if (!resolved.has(key)) resolved.set(key, { value, source: parsed.file });
  }
}

const rawOf = (key) => resolved.get(key)?.value ?? '';
/** The app unescapes `\n` in the private key, so compare against the same value. */
const valueOf = (key) => rawOf(key).replace(/\\n/g, '\n');
const sourceOf = (key) => resolved.get(key)?.source ?? 'default';
const isBlank = (key) => valueOf(key).trim() === '';

/** Never print a secret; a length is enough to spot a truncated paste. */
function describe(key) {
  const value = valueOf(key);
  if (value === '') return '(blank)';
  if (SECRET_KEYS.has(key)) return `(set, ${value.length} chars)`;
  return value.length > 46 ? `${value.slice(0, 43)}… (${value.length} chars)` : value;
}

console.log(`\nKeypad Firebase doctor — NODE_ENV=${NODE_ENV}`);
console.log(`env files, highest precedence first: ${files.map((f) => f.file).join(', ') || 'none'}\n`);

for (const key of ALL_KEYS) {
  if (!resolved.has(key)) continue;
  console.log(`  ${key.padEnd(38)} ${describe(key).padEnd(30)} ${sourceOf(key)}`);
}
console.log();

// A blank value in a higher-precedence file hides a real one below it. This is
// the most common reason a correctly filled-in .env appears to be ignored.
const shadowed = [];
const strayQuotes = [];
for (const key of ALL_KEYS) {
  const effective = resolved.get(key);
  if (!effective) continue;
  if (rawOf(key) === '"' || rawOf(key) === "'") strayQuotes.push(key);
  if (effective.value.trim() !== '' || effective.source === 'process env') continue;
  const startIndex = files.findIndex((parsed) => parsed.file === effective.source);
  const hidden = files
    .slice(startIndex + 1)
    .find((parsed) => (parsed.values.get(key) ?? '').trim() !== '');
  if (hidden) shadowed.push(`${key} (real value in ${hidden.file})`);
}

if (shadowed.length) {
  fail(
    `${shadowed.length} value(s) in ${files[0]?.file ?? '.env.local'} override real ones`,
    shadowed.join(', '),
    'Next.js reads .env.local before .env, and a key set to an empty value still counts as set. ' +
      'Delete these lines from the higher-precedence file, or move the real values into it — ' +
      'then restart the dev server.',
  );
}
if (strayQuotes.length) {
  fail(
    'unterminated quote',
    `${strayQuotes.join(', ')} parse to a stray quote character`,
    'A value that opens a quote must close it on the same line, otherwise dotenv keeps the quote ' +
      'as the value (and may swallow the lines below it).',
  );
}

// --- providers -------------------------------------------------------------

const wanted = { DATA_PROVIDER: 'firestore', STORAGE_PROVIDER: 'firebase' };
for (const key of PROVIDER_KEYS) {
  const value = valueOf(key);
  if (value === wanted[key]) ok(`${key}=${value}`, `from ${sourceOf(key)}`);
  else
    fail(
      `${key}=${value || '(unset, defaults to memory)'}`,
      `nothing is stored in Firebase until this is ${wanted[key]}`,
      `Set ${key}=${wanted[key]} and restart the dev server.`,
    );
}

// --- credentials -----------------------------------------------------------

const missingClient = [...CLIENT_KEYS, STORAGE_KEY].filter(isBlank);
if (missingClient.length) {
  fail(
    'Firebase web config incomplete',
    `unset: ${missingClient.join(', ')}`,
    'Firebase console → Project settings → Your apps → SDK setup and configuration. Without ' +
      'NEXT_PUBLIC_FIREBASE_API_KEY the browser cannot sign anybody up, so the API answers every ' +
      'registration with UNAUTHENTICATED ("complete the Firebase sign-up first").',
  );
} else {
  ok('Firebase web config complete', `all ${CLIENT_KEYS.length + 1} values set`);
}

const missingAdmin = ADMIN_KEYS.filter(isBlank);
if (missingAdmin.length) {
  fail(
    'Firebase Admin credentials incomplete',
    `unset: ${missingAdmin.join(', ')}`,
    'Firebase console → Project settings → Service accounts → Generate new private key. ' +
      'FIREBASE_PRIVATE_KEY goes on one line with its newlines escaped as \\n, inside double quotes.',
  );
} else {
  ok('Firebase Admin credentials present', `service account ${valueOf('FIREBASE_CLIENT_EMAIL')}`);
}

const privateKey = valueOf('FIREBASE_PRIVATE_KEY');
if (privateKey) {
  const body = privateKey
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey) || body.length < 100) {
    fail(
      'FIREBASE_PRIVATE_KEY is not a usable key',
      `PEM block ${/-----BEGIN/.test(privateKey) ? 'present' : 'missing'}, base64 body ${body.length} chars`,
      'A real PKCS#8 key has a body of roughly 1600 characters, so this is the .env.example ' +
        'placeholder or a truncated paste. Regenerate it and keep it on a single line.',
    );
  } else {
    ok('FIREBASE_PRIVATE_KEY shape', `PEM block with a ${body.length} char body`);
  }
}

const clientEmail = valueOf('FIREBASE_CLIENT_EMAIL');
if (clientEmail && !clientEmail.includes('@')) {
  fail(
    'FIREBASE_CLIENT_EMAIL is not an email address',
    describe('FIREBASE_CLIENT_EMAIL'),
    'It is the client_email from the service account key: firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com.',
  );
}

// --- Admin SDK -------------------------------------------------------------

let app = null;
if (!missingAdmin.length) {
  try {
    const { cert, initializeApp } = await import('firebase-admin/app');
    app = initializeApp(
      {
        credential: cert({
          projectId: valueOf('FIREBASE_PROJECT_ID'),
          clientEmail,
          privateKey,
        }),
        projectId: valueOf('FIREBASE_PROJECT_ID'),
      },
      'keypad-doctor',
    );
    ok('Firebase Admin SDK initialised', `project ${valueOf('FIREBASE_PROJECT_ID')}`);
  } catch (error) {
    app = null;
    fail(
      'Firebase Admin SDK failed to initialise',
      error.message,
      'Usually a malformed private key, or a key generated for a different project than FIREBASE_PROJECT_ID.',
    );
  }
} else {
  skip('Firebase Admin SDK', 'credentials incomplete');
}

/** Turns the errors Firestore, Auth and Storage actually throw into a next step. */
function explain(error) {
  const message = String(error?.message ?? error);
  if (/Cloud Firestore API is not enabled|not enabled for the project/i.test(message)) {
    return 'Create the database first: Firebase console → Firestore Database → Create database (production mode).';
  }
  if (/requires an index/i.test(message)) {
    const url = message.match(/https:\/\/console\.firebase\.google\.com\S+/)?.[0];
    return (
      'Deploy the composite indexes: npm run firebase:deploy:rules (needs firebase-tools plus `firebase use <project-id>`).' +
      (url ? ` Or create this one directly: ${url}` : '')
    );
  }
  if (/OPERATION_NOT_ALLOWED/i.test(message)) {
    return 'Enable the provider: Firebase console → Authentication → Sign-in method → Email/Password → Enable.';
  }
  if (/API_KEY_INVALID|KEY_INVALID/i.test(message)) {
    return 'NEXT_PUBLIC_FIREBASE_API_KEY does not belong to this project, or the Identity Toolkit API is disabled.';
  }
  if (/unauthenticated|invalid_grant|Failed to parse|token/i.test(message)) {
    return 'The service account key is not accepted — regenerate it and check FIREBASE_PROJECT_ID matches.';
  }
  if (/PERMISSION_DENIED|permission/i.test(message)) {
    return 'The service account has no access — check it belongs to this project and has not been revoked.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|deadline|timed out/i.test(message)) {
    return 'This machine could not reach Google APIs — check the network, firewall, proxy or DNS.';
  }
  if (/No such object|404|not found/i.test(message)) {
    return 'The bucket does not exist — Firebase console → Storage → Get started, then set NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET to the name shown there.';
  }
  return undefined;
}

// --- connectivity ----------------------------------------------------------

// Every Firebase provider is a hosted service, so if this machine cannot reach
// Google the three probes below would each burn their full timeout. Ask once,
// quickly, and skip them with a single explanation instead.
let reachable = false;
if (app) {
  try {
    const response = await fetch('https://www.googleapis.com/', { signal: AbortSignal.timeout(8000) });
    reachable = response.status < 500;
    ok('Google APIs reachable', `www.googleapis.com answered ${response.status}`);
  } catch (error) {
    fail(
      'Google APIs are not reachable from this machine',
      error.message,
      'The Admin SDK talks to Firebase over HTTPS, so a firewall, proxy, VPN or DNS problem blocks ' +
        'Firestore, Auth and Storage alike. Nothing below can pass until this does.',
    );
  }
} else {
  skip('Google APIs', 'the Admin SDK did not initialise');
}

/** Why a network probe was skipped, for the two cases that are not failures. */
function probeBlocked() {
  if (!app) return 'the Admin SDK did not initialise';
  return reachable ? undefined : 'Google APIs are not reachable from this machine';
}

// --- Firestore -------------------------------------------------------------

if (app && reachable) {
  try {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(app);
    await withTimeout('the Firestore probe', async () => {
      const probe = db.collection('mtDoctorProbes').doc('probe');
      await probe.set({ at: new Date().toISOString(), purpose: 'keypad-doctor' });
      const read = await probe.get();
      if (!read.exists) throw new Error('the probe document was written but could not be read back');
      await probe.delete();
    });
    ok('Firestore read + write', 'probe document created, read back and deleted');

    // The conversation list needs a composite index; without it the app fails
    // only once somebody opens a chat, so ask for it now. Querying an empty
    // subcollection is enough to make Firestore validate the query plan.
    try {
      await withTimeout(
        'the Firestore index query',
        () =>
          db
            .collection('userConversations')
            .doc('keypad-doctor-index-probe')
            .collection('items')
            .where('hidden', '==', false)
            .orderBy('lastActivityAt', 'desc')
            .limit(1)
            .get(),
      );
      ok('Firestore composite index', 'the conversation-list query is served by an index');
    } catch (error) {
      if (/requires an index/i.test(String(error?.message))) {
        fail('Firestore composite index missing', 'the conversation-list query has no index', explain(error));
      } else {
        throw error;
      }
    }
  } catch (error) {
    fail('Firestore unreachable', error.message, explain(error));
  }
} else {
  skip('Firestore', probeBlocked());
}

// --- Authentication --------------------------------------------------------

if (NO_SIGNUP) {
  skip('Firebase Auth sign-up probe', '--no-signup given');
} else if (isBlank('NEXT_PUBLIC_FIREBASE_API_KEY')) {
  skip('Firebase Auth sign-up probe', 'NEXT_PUBLIC_FIREBASE_API_KEY is unset');
} else if (probeBlocked()) {
  skip('Firebase Auth sign-up probe', probeBlocked());
} else {
  const email = `keypad-doctor-${Date.now()}@example.com`;
  const password = randomBytes(12).toString('base64url');
  let localId = null;
  try {
    const payload = await withTimeout('the Firebase Auth sign-up call', async () => {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(valueOf('NEXT_PUBLIC_FIREBASE_API_KEY'))}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = body?.error?.message ?? `HTTP ${response.status}`;
        const error = new Error(reason);
        error.code = reason;
        throw error;
      }
      return body;
    });
    localId = payload.localId;

    // Exactly what the API does for every authenticated request.
    if (app) {
      const { getAuth } = await import('firebase-admin/auth');
      await withTimeout('ID token verification', async () => {
        const decoded = await getAuth(app).verifyIdToken(payload.idToken, true);
        if (decoded.uid !== localId) throw new Error('the ID token resolved to a different uid');
      });
      ok('Firebase Auth sign-up + ID token verification', `${email} created, verified and deleted`);
    } else {
      ok('Firebase Auth sign-up', `${email} created — Email/Password is enabled`);
    }
  } catch (error) {
    fail('Firebase Auth sign-up failed', error.message, explain(error));
  } finally {
    if (localId && app) {
      try {
        const { getAuth } = await import('firebase-admin/auth');
        await withTimeout('deleting the probe user', () => getAuth(app).deleteUser(localId));
      } catch (error) {
        warn(
          'could not delete the probe user',
          `${email}: ${error.message}`,
          'Delete it in Firebase console → Authentication → Users.',
        );
      }
    }
  }
}

// --- Storage ---------------------------------------------------------------

if (app && reachable) {
  try {
    const { getStorage } = await import('firebase-admin/storage');
    const storage = getStorage(app);
    const projectId = valueOf('FIREBASE_PROJECT_ID');
    const configured = valueOf(STORAGE_KEY).trim();
    // Both default-bucket shapes exist in the wild: `.firebasestorage.app` for
    // projects created since 2024, `.appspot.com` for older ones.
    const candidates = [
      ...new Set([configured, `${projectId}.firebasestorage.app`, `${projectId}.appspot.com`].filter(Boolean)),
    ];

    let bucket = null;
    await withTimeout('the Storage bucket lookup', async () => {
      for (const name of candidates) {
        const [exists] = await storage.bucket(name).exists();
        if (!exists) continue;
        bucket = storage.bucket(name);
        if (configured && name !== configured) {
          warn(
            'Storage bucket mismatch',
            `${configured} does not exist but ${name} does`,
            `Set ${STORAGE_KEY}=${name} so the browser and the server agree on one bucket.`,
          );
        } else {
          ok('Storage bucket found', name);
        }
        break;
      }
    });
    if (!bucket) {
      fail(
        'no Storage bucket exists',
        `tried: ${candidates.join(', ')}`,
        'Firebase console → Storage → Get started. Then set NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET to the bucket name shown there.',
      );
    } else {
      await withTimeout('the Storage probe', async () => {
        const path = 'media/__doctor_probe__.txt';
        const file = bucket.file(path);
        await file.save(Buffer.from('keypad doctor probe'), { contentType: 'text/plain', resumable: false });
        const [bytes] = await file.download();
        await file.delete();
        ok('Storage upload + download', `${path} written, read back (${bytes.length} bytes) and deleted`);
      });
    }
  } catch (error) {
    fail('Storage check failed', error.message, explain(error));
  }
} else {
  skip('Storage', probeBlocked());
}

// --- administrator + running server ----------------------------------------

if (!isBlank('ADMIN_UID')) ok('ADMIN_UID', `set from ${sourceOf('ADMIN_UID')}`);
else if (!isBlank('ADMIN_EMAIL'))
  ok('ADMIN_EMAIL', `${valueOf('ADMIN_EMAIL')} from ${sourceOf('ADMIN_EMAIL')} — no uid pinned yet`);
else
  warn(
    'no administrator configured',
    'ADMIN_UID and ADMIN_EMAIL are both unset',
    'Register through the app, then set ADMIN_UID to the uid the admin panel shows and run: ' +
      'ADMIN_UID=<uid> node scripts/set-admin-claim.mjs',
  );

if (BASE_URL) {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/health`, { signal: AbortSignal.timeout(4000) });
    const payload = await response.json();
    const running = payload?.data ?? {};
    const expected = { dataProvider: 'firestore', authProvider: 'firebase', storageProvider: 'firebase' };
    const mismatched = Object.entries(expected).filter(([key, value]) => running[key] && running[key] !== value);
    if (!response.ok) {
      warn(
        `the dev server at ${BASE_URL} answered ${response.status}`,
        'it is running but unhealthy',
        'Read its terminal — boot failures are logged there.',
      );
    } else if (mismatched.length) {
      fail(
        'the running dev server uses different providers',
        mismatched.map(([key, value]) => `${key}=${running[key]} (expected ${value})`).join(', '),
        'Restart it: it was started before the env files changed, so it is still using the old values.',
      );
    } else {
      ok(
        'the running dev server agrees',
        `${BASE_URL} reports ${running.dataProvider}/${running.authProvider}/${running.storageProvider}`,
      );
    }
  } catch {
    skip(`no dev server at ${BASE_URL}`, 'start one with npm run dev, or pass --no-server');
  }
}

// --- summary ---------------------------------------------------------------

const failed = results.filter((result) => result.status === FAIL);
const warnings = results.filter((result) => result.status === WARN);
const passed = results.filter((result) => result.status === OK).length;
const skipped = results.filter((result) => result.status === SKIP).length;

console.log(`\n${passed} passed, ${warnings.length} warning(s), ${skipped} skipped, ${failed.length} failed`);
if (!failed.length) {
  console.log('\nFirebase is reachable and correctly configured. Two things this script cannot check:');
  console.log('  • Authorised domains — a deployed URL must be listed under Authentication → Settings →');
  console.log('    Authorised domains. localhost is already allowed, so local development needs nothing.');
  console.log('  • Security rules — the Admin SDK bypasses them. Deploy them anyway for defence in depth:');
  console.log('    npm run firebase:deploy:rules');
}
console.log();
process.exit(failed.length ? 1 : 0);

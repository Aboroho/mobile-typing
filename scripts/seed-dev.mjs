#!/usr/bin/env node
/**
 * Seeds the in-memory development database with two demo users and prints the
 * value to put in ADMIN_UID.
 *
 * It talks to a *running* dev server (default http://localhost:3000) through the
 * public API, so it exercises exactly the same code path as the browser.
 *
 * The administrator's email and password and the secret code all come from the
 * environment — the same keys the application itself uses — never from
 * hard-coded defaults in this file:
 *
 *   ADMIN_EMAIL       administrator account email          (required)
 *   ADMIN_PASSWORD    administrator account password       (required, >= 8 chars)
 *   SEED_SECRET_CODE  access code used to unlock the gate  (falls back to the
 *                     code the dev challenge hands out)
 *
 * Values are read from the process environment first, then from `.env.local`,
 * then from `.env` — the same precedence Next.js uses for those files.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const PASSWORD_MIN_LENGTH = 8;

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
const SECRET_CODE = process.env.SEED_SECRET_CODE;

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

async function post(path, body, cookie) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(
      `${path} failed (${response.status}): ${JSON.stringify(payload.error ?? payload)}`,
    );
  }
  return { payload: payload.data, cookies: response.headers.getSetCookie?.() ?? [] };
}

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
        accessCookie,
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

async function main() {
  const health = await fetch(`${BASE_URL}/api/v1/health`).then((response) => response.json());
  console.log('server:', health.data?.dataProvider, 'auth:', health.data?.authProvider);

  // The access flow must be completed before registering, exactly like a browser.
  const accessCookie = await unlockAccess();

  for (const [email, name] of [
    [ADMIN_EMAIL, 'Administrator'],
    [PEER_EMAIL, 'Peer User'],
  ]) {
    try {
      const { payload } = await post(
        '/api/v1/auth/register',
        { name, email, password: ADMIN_PASSWORD, confirmPassword: ADMIN_PASSWORD },
        accessCookie,
      );
      console.log(
        `created ${email} -> uid ${payload.user.id}${payload.user.isAdmin ? ' (ADMIN)' : ''}`,
      );
    } catch (error) {
      console.log(`skipped ${email}: ${error.message}`);
    }
  }

  console.log('\nAdministrator identity comes from the environment (ADMIN_EMAIL / ADMIN_UID).');
  console.log(
    `ADMIN_EMAIL=${ADMIN_EMAIL} is already set — to pin it by uid instead, add this to .env.local and restart the dev server:`,
  );
  console.log(`  ADMIN_UID=<uid printed above for ${ADMIN_EMAIL}>`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

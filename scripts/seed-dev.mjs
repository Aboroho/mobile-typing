#!/usr/bin/env node
/**
 * Seeds the in-memory development database with two demo users and prints the
 * value to put in ADMIN_UID.
 *
 * It talks to a *running* dev server (default http://localhost:3000) through the
 * public API, so it exercises exactly the same code path as the browser.
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
const PEER_EMAIL = process.env.SEED_PEER_EMAIL ?? 'peer@example.com';

async function post(path, body, cookie) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(payload.error ?? payload)}`);
  }
  return { payload: payload.data, cookies: response.headers.getSetCookie?.() ?? [] };
}

function cookieHeader(cookies) {
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function main() {
  const health = await fetch(`${BASE_URL}/api/v1/health`).then((response) => response.json());
  console.log('server:', health.data?.dataProvider, 'auth:', health.data?.authProvider);

  // The access flow must be completed before registering, exactly like a browser.
  const { payload: challengePayload, cookies } = await post('/api/v1/access/challenge', {});
  const digest = await sha256(challengePayload.challenge.code);
  const unlock = await post(
    '/api/v1/access/unlock',
    { challengeToken: challengePayload.challenge.challengeToken, digest },
    cookieHeader(cookies),
  );
  const accessCookie = cookieHeader(unlock.cookies);

  for (const [email, name] of [[ADMIN_EMAIL, 'Administrator'], [PEER_EMAIL, 'Peer User']]) {
    try {
      const { payload } = await post(
        '/api/v1/auth/register',
        { name, email, password: ADMIN_PASSWORD, confirmPassword: ADMIN_PASSWORD },
        accessCookie,
      );
      console.log(`created ${email} -> uid ${payload.user.id}${payload.user.isAdmin ? ' (ADMIN)' : ''}`);
    } catch (error) {
      console.log(`skipped ${email}: ${error.message}`);
    }
  }

  console.log('\nPut this in .env.local, then restart the dev server:');
  console.log(`  ADMIN_EMAIL=${ADMIN_EMAIL}`);
  console.log(`  ADMIN_UID=<uid printed above for ${ADMIN_EMAIL}>`);
}

async function sha256(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

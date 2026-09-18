import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = 'BrowserRegression42!';
const emulator = 'http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1';

async function openEntry(page: Page, gameEnabled: boolean, reload = false) {
  const challenge = gameEnabled
    ? page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/access/challenge' && response.ok(),
      )
    : null;
  if (reload) await page.reload();
  else await page.goto('/');
  if (challenge) {
    await (await challenge).finished();
    await page.getByRole('button', { name: 'Start test' }).click();
    await page
      .getByLabel('Type the word shown above')
      .pressSequentially('opensesame', { delay: 80 });
  } else {
    await expect(page.getByRole('button', { name: 'Start test' })).toHaveCount(0);
  }
}

/** No mocked browser/API responses: both Firebase SDKs talk to the real emulator. */
test('signup → session restore → logout → invalid password → login', async ({
  page,
  context,
  request,
}, testInfo) => {
  test.skip(
    !testInfo.config.metadata.firebaseAuthEmulator,
    'Run with npm run e2e:auth (isolated Auth emulator).',
  );
  const gameEnabled = Boolean(testInfo.config.metadata.typingGameEnabled);
  const email = `keypad-e2e-${randomUUID()}@example.com`;
  const runtimeErrors: string[] = [];
  const policyErrors: string[] = [];
  const authRequests: Array<{ path: string; body: string }> = [];
  const externalAuthRequests: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /content security policy|violates the following/i.test(message.text())
    ) {
      policyErrors.push(message.text());
    }
  });
  page.on('request', (outgoing) => {
    const url = new URL(outgoing.url());
    if (url.pathname.startsWith('/api/v1/auth/')) {
      authRequests.push({ path: url.pathname, body: outgoing.postData() ?? '' });
    }
    if (url.hostname.endsWith('.googleapis.com')) externalAuthRequests.push(url.hostname);
  });

  try {
    await openEntry(page, gameEnabled);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByPlaceholder('Your name').fill('Browser Auth Test');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('input[type="password"]').nth(0).fill(password);
    await page.locator('input[type="password"]').nth(1).fill(password);
    const registered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/auth/register',
    );
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    const registration = await registered;
    expect(registration.status()).toBe(201);
    const { data: created } = await registration.json();
    expect(created).toMatchObject({
      user: { name: 'Browser Auth Test', email },
      token: null,
      cookieSession: true,
      accessGranted: gameEnabled,
    });
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
    await expect(page.getByText('No conversations yet')).toBeVisible();
    expect(authRequests.filter(({ path }) => path === '/api/v1/auth/register')).toHaveLength(1);

    // Cookie-only requests (including EventSource) must work, not only bearer calls.
    const cookies = await context.cookies();
    expect(cookies.find((cookie) => cookie.name === 'mt_session')).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(await page.evaluate(async () => (await fetch('/api/v1/conversations')).status)).toBe(
      200,
    );

    // Firebase persistence restores the same account without another registration.
    await openEntry(page, gameEnabled, true);
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
    await expect(page.getByText('Browser Auth Test', { exact: true })).toBeVisible();
    expect(authRequests.filter(({ path }) => path === '/api/v1/auth/register')).toHaveLength(1);

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    const loggedOut = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/auth/logout',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect((await loggedOut).status()).toBe(200);
    expect((await context.cookies()).some((cookie) => cookie.name === 'mt_session')).toBe(false);
    // A copied pre-logout cookie cannot be replayed against the API.
    const replay = await request.get('/api/v1/conversations', {
      headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
    });
    expect(replay.status()).toBe(401);

    await openEntry(page, gameEnabled);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('input[type="password"]').fill('IncorrectPassword42!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText(
      'unable to sign in with those details',
    );
    // Firebase rejects it before a password could reach this app's login route.
    expect(authRequests.filter(({ path }) => path === '/api/v1/auth/login')).toHaveLength(0);

    await page.locator('input[type="password"]').fill(password);
    const loggedIn = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/auth/login',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const login = await loggedIn;
    expect(login.status()).toBe(200);
    expect((await login.json()).data).toMatchObject({
      user: { id: created.user.id, name: 'Browser Auth Test', email },
      accessGranted: gameEnabled,
    });
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
    await expect(page.getByText('No conversations yet')).toBeVisible();
    expect(authRequests.map(({ body }) => body).join('\n')).not.toContain(password);
    expect(externalAuthRequests).toEqual([]);
    expect(runtimeErrors).toEqual([]);
    expect(policyErrors).toEqual([]);
  } finally {
    // Only the local emulator is contacted, even if the browser test failed.
    const signedIn = await request.post(
      `${emulator}/accounts:signInWithPassword?key=demo-keypad-api-key`,
      {
        data: { email, password, returnSecureToken: true },
      },
    );
    if (signedIn.ok()) {
      const { idToken } = await signedIn.json();
      const deleted = await request.post(`${emulator}/accounts:delete?key=demo-keypad-api-key`, {
        data: { idToken },
      });
      expect(deleted.ok()).toBe(true);
    }
  }
});

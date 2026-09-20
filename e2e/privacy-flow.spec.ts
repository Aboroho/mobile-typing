import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Privacy triggers on a real chat screen.
 *
 * NOTE: these specs need a browser binary (`npm run e2e:install`). The same
 * rules are covered without one by `tests/browser/double-tap.test.ts`,
 * `tests/browser/visibility-policy.test.ts` and
 * `tests/client/chat-privacy.test.tsx` — the last of which renders the real
 * `ChatScreen` — and those do run in CI.
 */

const SECRET_CODE = process.env.SEED_SECRET_CODE ?? 'opensesame';
const PASSWORD = 'CorrectHorse1!';

/** The subset of Playwright's `playwright` fixture this file needs. */
interface PlaywrightFixture {
  request: { newContext(options: { baseURL: string }): Promise<APIRequestContext> };
}

/** Registers a throwaway account through the API and returns its cookie jar. */
async function registerViaApi(api: APIRequestContext, name: string): Promise<string> {
  const response = await api.post('/api/v1/auth/register', {
    data: { name, email: `e2e-${name}-${Date.now()}@example.com`, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.data.user.id as string;
}

/**
 * Signs the browser in through the real UI, then seeds a conversation with a
 * second account so there is a thread to open. The peer is created in a
 * separate request context so it cannot overwrite the browser's session cookie.
 */
async function openThreadWithOneMessage(page: Page, playwright: PlaywrightFixture): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start test' }).click();
  const input = page.getByLabel('Type the word shown above');
  await input.click();
  for (const character of SECRET_CODE) {
    await input.press(character === ' ' ? 'Space' : character);
  }
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByPlaceholder('Your name').fill('Privacy Tester');
  await page.getByPlaceholder('you@example.com').fill(`privacy-${Date.now()}@example.com`);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('No conversations yet')).toBeVisible({ timeout: 20_000 });

  const peerApi = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
  const peerName = `Peer ${Date.now()}`;
  const peerId = await registerViaApi(peerApi, peerName);

  // `page.request` shares the browser's cookies, so this runs as the signed-in user.
  const created = await page.request.post('/api/v1/conversations', { data: { participantId: peerId } });
  expect(created.ok()).toBeTruthy();
  const createdBody = await created.json();
  const conversationId = createdBody.data.conversation.conversation.id as string;

  await peerApi.post('/api/v1/messages', {
    data: {
      conversationId,
      type: 'text',
      text: 'double tap anywhere in this list',
      clientMessageId: `e2e-${Date.now()}-seed`,
    },
  });
  await peerApi.dispose();

  await page.goto(`/conversations/${conversationId}`);
  await expect(page.getByText('double tap anywhere in this list')).toBeVisible({ timeout: 20_000 });
}

test.describe('privacy triggers', () => {
  test('the Hide button returns to the typing test', async ({ page, playwright }) => {
    await openThreadWithOneMessage(page, playwright);
    await page.getByRole('button', { name: /hide chat/i }).click();
    await expect(page.getByRole('heading', { name: 'Keypad' })).toBeVisible({ timeout: 10_000 });
  });

  test('a double tap in the message area hides the chat', async ({ page, playwright }) => {
    await openThreadWithOneMessage(page, playwright);
    const message = page.getByText('double tap anywhere in this list');
    const box = await message.boundingBox();
    expect(box).not.toBeNull();
    const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
    // Two taps, well inside the 350 ms / 48 px thresholds.
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
    await expect(page.getByRole('heading', { name: 'Keypad' })).toBeVisible({ timeout: 10_000 });
  });

  test('a single tap does not hide the chat', async ({ page, playwright }) => {
    await openThreadWithOneMessage(page, playwright);
    const message = page.getByText('double tap anywhere in this list');
    const box = await message.boundingBox();
    await page.touchscreen.tap((box?.x ?? 0) + 10, (box?.y ?? 0) + 10);
    await page.waitForTimeout(600);
    await expect(message).toBeVisible();
  });

  test('a short blur does not hide the chat', async ({ page, playwright }) => {
    await openThreadWithOneMessage(page, playwright);
    // Backgrounding the tab for a moment must not lock; only 60 s of hidden does.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
    await page.waitForTimeout(2_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.getByText('double tap anywhere in this list')).toBeVisible();
  });
});

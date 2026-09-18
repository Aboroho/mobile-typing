import { expect, test, type Page } from '@playwright/test';

const SECRET_CODE = process.env.SEED_SECRET_CODE ?? 'opensesame';

// Actual signup/login is exercised safely by `npm run e2e:auth`.

/** Types the secret code into the game, character by character, and unlocks. */
async function unlockWithSecretCode(page: Page) {
  const challenge = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/access/challenge' && response.ok(),
  );
  await page.goto('/');
  await (await challenge).finished();
  await page.getByRole('button', { name: 'Start test' }).click();

  const input = page.getByLabel('Type the word shown above');
  await input.click();
  for (const character of SECRET_CODE) {
    await input.press(character === ' ' ? 'Space' : character);
  }
}

test.describe('access flow', () => {
  test('unlocking with the secret code reveals sign-in', async ({ page }) => {
    await unlockWithSecretCode(page);

    // The auth panel replaces the game — an unlocked browser sees sign-in first.
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  });

  test('the game is still the only entry point on a fresh browser', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Keypad' })).toBeVisible();
    await context.close();
  });
});

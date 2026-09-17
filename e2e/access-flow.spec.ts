import { expect, test } from '@playwright/test';

const SECRET_CODE = process.env.SEED_SECRET_CODE ?? 'opensesame';

/**
 * The access flow, end to end: type the secret code into the game, register,
 * reach the chat, then lock again with a triple tap.
 */
test.describe('access flow', () => {
  test('unlocking with the secret code reveals sign-in, and the chat opens after registering', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start test' }).click();

    const input = page.getByLabel('Type the word shown above');
    await input.click();
    // Typed character by character, exactly as a real user would.
    for (const character of SECRET_CODE) {
      await input.press(character === ' ' ? 'Space' : character);
    }

    // The auth panel replaces the game — an unlocked browser sees sign-in first.
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

    const email = `e2e-${Date.now()}@example.com`;
    await page.getByPlaceholder('Your name').fill('E2E Tester');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('input[type="password"]').first().fill('CorrectHorse1!');
    await page.locator('input[type="password"]').nth(1).fill('CorrectHorse1!');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('No conversations yet')).toBeVisible({ timeout: 20_000 });
  });

  test('the game is still the only entry point on a fresh browser', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Keypad' })).toBeVisible();
    await context.close();
  });
});

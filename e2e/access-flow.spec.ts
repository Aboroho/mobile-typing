import { expect, test, type Page } from '@playwright/test';

const SECRET_CODE = process.env.SEED_SECRET_CODE ?? 'opensesame';

/**
 * Authentication is Firebase Authentication and has no offline fallback, so the
 * steps that create an account need a Firebase project: the browser signs up with
 * the Firebase client SDK (`NEXT_PUBLIC_FIREBASE_*`) and the dev server verifies
 * the ID token with the Admin SDK (`FIREBASE_*`). Point both halves at the Auth
 * emulator (`FIREBASE_AUTH_EMULATOR_HOST`) to run them without a real project.
 * The access flow itself needs none of that and always runs.
 */
const firebaseConfigured = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

/** Types the secret code into the game, character by character, and unlocks. */
async function unlockWithSecretCode(page: Page) {
  await page.goto('/');
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

  test('registering opens the chat', async ({ page }) => {
    test.skip(
      !firebaseConfigured,
      'Registration goes through Firebase Authentication: set NEXT_PUBLIC_FIREBASE_API_KEY (and the ' +
        'other NEXT_PUBLIC_FIREBASE_* values plus the Admin credentials) in .env.local, or run both ' +
        'against the Auth emulator with FIREBASE_AUTH_EMULATOR_HOST.',
    );

    await unlockWithSecretCode(page);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Create an account' }).click();
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

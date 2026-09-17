import { expect, test } from '@playwright/test';

/**
 * The public face of the product. Nothing here may hint at messaging.
 */
test.describe('typing game', () => {
  test('shows only a typing test to a first-time visitor', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Keypad' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start test' })).toBeVisible();

    // No trace of the private app in the rendered page.
    const body = (await page.locator('body').innerText()).toLowerCase();
    for (const forbidden of ['chat', 'message', 'conversation', 'sign in', 'unlock']) {
      expect(body).not.toContain(forbidden);
    }
  });

  test('runs a test and shows the result screen', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start test' }).click();

    const input = page.getByLabel('Type the word shown above');
    await expect(input).toBeFocused();

    // Read the target word the game rendered, type it, then finish early.
    const word = (await page.getByTestId('target-word').innerText()).trim();
    await input.fill(word);
    await input.press('Enter');
    await expect(page.getByText(/Word 2 of/)).toBeVisible();
    await page.getByRole('button', { name: 'Finish early' }).click();

    await expect(page.getByRole('heading', { name: 'Test complete' })).toBeVisible();
    await expect(page.getByText('Accuracy')).toBeVisible();
  });

  test('offers Bengali as well as English', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('button', { name: 'Start test' }).click();
    await expect(page.getByLabel('Type the word shown above')).toBeVisible();
  });
});

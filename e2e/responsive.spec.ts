import { expect, test } from '@playwright/test';

/** The layout must hold from a small phone to a desktop window. */
test('the game is usable at 320px and at 1280px', async ({ page }) => {
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start test' })).toBeVisible();
    // No horizontal scrolling at any supported width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});

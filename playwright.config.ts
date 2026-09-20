import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests.
 *
 *   npm run e2e:install   # once: downloads Chromium
 *   npm run e2e           # starts the dev server and runs the specs
 *
 * They run against the development data and storage providers, so nothing is
 * written to a real database. Authentication is email + password against the
 * dev server itself, so the specs that sign in need no external service.
 * A mobile viewport is used because the product is mobile-first; a desktop
 * project is included for the responsive check.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DATA_PROVIDER: 'memory',
      STORAGE_PROVIDER: 'memory',
    },
  },
});

import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import base from './playwright.config';

const typingGameEnabled = process.env.E2E_TYPING_GAME !== 'false';

/**
 * Real browser + Firebase client SDK + Admin SDK, backed only by the Auth
 * emulator and memory repositories. No private key or live project is used.
 * Stop any existing dev server first; never reuse an unknown/live server here.
 */
export default defineConfig({
  ...base,
  testMatch: 'auth.spec.ts',
  workers: 1,
  metadata: { firebaseAuthEmulator: true, typingGameEnabled },
  use: { ...base.use, baseURL: 'http://localhost:3000' },
  webServer: [
    {
      command:
        `${process.env.FIREBASE_CLI ?? 'npx --yes firebase-tools@15.30.2'} ` +
        'emulators:start --only auth --project demo-keypad --config firebase.auth-test.json',
      port: 9199,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NODE_ENV: 'development',
        APP_ENV: 'test',
        DATA_PROVIDER: 'memory',
        STORAGE_PROVIDER: 'memory',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9199',
        FIREBASE_PROJECT_ID: 'demo-keypad',
        FIREBASE_CLIENT_EMAIL: '',
        FIREBASE_PRIVATE_KEY: '',
        NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-keypad-api-key',
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-keypad.firebaseapp.com',
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-keypad',
        NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-keypad.appspot.com',
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
        NEXT_PUBLIC_FIREBASE_APP_ID: '1:1234567890:web:local-keypad',
        NEXT_PUBLIC_ENABLE_TYPING_GAME: String(typingGameEnabled),
        ADMIN_UID: '',
        ADMIN_EMAIL: '',
        APP_SECRET: randomBytes(32).toString('hex'),
        SEED_SECRET_CODE: 'opensesame',
        ENABLE_SECURITY_HEADERS: 'true',
        CSP_MODE: 'enforce',
        DEV_ALLOWED_ORIGINS: '',
        DEV_FRAME_ANCESTORS: '',
      },
    },
  ],
});

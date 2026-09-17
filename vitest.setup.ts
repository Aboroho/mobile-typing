/**
 * Global test setup.
 *
 * Tests run against the in-memory data and storage providers and against an
 * in-process double for Firebase Authentication (`tests/helpers/firebase-auth.ts`),
 * so no Firebase project, emulator or JVM is required. The double implements the
 * Admin SDK surface this application uses, with the rules the application relies
 * on: signed credentials that fail when tampered with, revocation, disabled
 * accounts, and the five-minute window in which an ID token may be exchanged for
 * a session cookie. Everything above that boundary is the real code.
 *
 * `APP_ENV` is forced to `test`, which keeps the (development only) data and
 * storage fallbacks enabled while still refusing to silently downgrade a
 * production build.
 */
import { TextDecoder, TextEncoder } from 'node:util';
import { beforeEach, vi } from 'vitest';

process.env.APP_ENV = 'test';
// NODE_ENV is often typed read-only; cast through unknown for the test runner.
(process.env as { NODE_ENV?: string }).NODE_ENV = 'test';
process.env.APP_SECRET = 'test-app-secret-0123456789';
process.env.ADMIN_UID = 'admin-uid';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.DATA_PROVIDER = 'memory';
process.env.STORAGE_PROVIDER = 'memory';
process.env.SEED_SECRET_CODE = 'opensesame';

// The Firebase web configuration a browser would use, pointing at the same test
// project the authentication double mints credentials for.
process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'AIzaSy-test-key';
process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = 'keypad-test.firebaseapp.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'keypad-test';
process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = '1234567890';
process.env.NEXT_PUBLIC_FIREBASE_APP_ID = '1:1234567890:web:testappid';

/**
 * Firebase Authentication has no offline mode: the Admin SDK needs a service
 * account and a network. Only `getAdminAuth` is replaced, so the rest of
 * `lib/firebase/admin.ts` (storage bucket resolution, for example) stays real.
 */
vi.mock('@/lib/firebase/admin', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { fakeAdminAuth } = await import('./tests/helpers/firebase-auth');
  return { ...actual, getAdminAuth: () => fakeAdminAuth };
});

beforeEach(async () => {
  const { resetFirebaseAuth } = await import('./tests/helpers/firebase-auth');
  resetFirebaseAuth();
});

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder as unknown as typeof globalThis.TextEncoder;
  globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;
}

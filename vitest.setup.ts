/**
 * Global test setup.
 *
 * Tests run against the in-memory data and storage providers. Authentication
 * is Argon2id + cookie sessions; no external services are required.
 */
import { TextDecoder, TextEncoder } from 'node:util';
import { afterEach } from 'vitest';
import { resetMessageWriteBehind } from '@/lib/services/message-service';

/**
 * Message delivery is notify-first: the socket event goes out immediately and
 * the database write follows in the background. Waiting for those in-flight
 * writes after every test keeps the next test's fresh store clean and makes
 * database assertions deterministic.
 */
afterEach(async () => {
  await resetMessageWriteBehind();
});

process.env.APP_ENV = 'test';
(process.env as { NODE_ENV?: string }).NODE_ENV = 'test';
process.env.APP_SECRET = 'test-app-secret-0123456789abcdef';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.DATA_PROVIDER = 'memory';
process.env.STORAGE_PROVIDER = 'memory';
process.env.SEED_SECRET_CODE = 'opensesame';

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder as unknown as typeof globalThis.TextEncoder;
  globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;
}

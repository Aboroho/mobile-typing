/**
 * Global test setup.
 *
 * Tests always run against the in-memory data/auth/storage providers so that no
 * Firebase project is required. `APP_ENV` is forced to `test`, which also keeps
 * the (development only) fallback providers enabled while still refusing to
 * silently downgrade a production build.
 */
process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.DEV_SESSION_SECRET = 'test-dev-session-secret-0123456789';
process.env.APP_SECRET = 'test-app-secret-0123456789';
process.env.ADMIN_UID = 'admin-uid';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.DATA_PROVIDER = 'memory';
process.env.AUTH_PROVIDER = 'dev';
process.env.STORAGE_PROVIDER = 'memory';
process.env.SEED_SECRET_CODE = 'opensesame';

if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = await import('node:util');
  globalThis.TextEncoder = TextEncoder as unknown as typeof globalThis.TextEncoder;
  globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;
}

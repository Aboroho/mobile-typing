import { deleteApp, getApps } from 'firebase-admin/app';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminApp, resetAdminCache } from '@/lib/firebase/admin';
import { resetEnvCache } from '@/lib/env';

beforeEach(() => {
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9199');
  vi.stubEnv('FIREBASE_PROJECT_ID', 'demo-keypad');
  vi.stubEnv('FIREBASE_CLIENT_EMAIL', '');
  vi.stubEnv('FIREBASE_PRIVATE_KEY', '');
  resetEnvCache();
  resetAdminCache();
});

afterEach(async () => {
  await Promise.all(
    getApps()
      .filter((app) => app.name === 'mt')
      .map((app) => deleteApp(app)),
  );
  resetAdminCache();
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe('server Auth emulator configuration', () => {
  it('initialises with a demo project id and no real service-account key', () => {
    expect(getAdminApp().options.projectId).toBe('demo-keypad');
  });

  it('does not silently fall back to emulation when credentials are absent', () => {
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '');
    resetEnvCache();
    expect(() => getAdminApp()).toThrow('Firebase Admin credentials are missing');
  });

  it.each(['NODE_ENV', 'APP_ENV'] as const)(
    'refuses unsigned emulator tokens when %s is production',
    (key) => {
      vi.stubEnv(key, 'production');
      resetEnvCache();
      expect(() => getAdminApp()).toThrow(
        'FIREBASE_AUTH_EMULATOR_HOST must not be set in production',
      );
    },
  );
});

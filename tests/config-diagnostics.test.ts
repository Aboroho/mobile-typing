import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectConfigIssues,
  parsePublicEnv,
  parseServerEnv,
  type ConfigIssue,
} from '@mt/config';
import { reportConfigIssues, resetReportedConfigIssues } from '@/lib/diagnostics';

/** Shaped like a real PKCS#8 key: a PEM block with a long base64 body. */
const fakePrivateKey = `-----BEGIN PRIVATE KEY-----\\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(6)}\\n-----END PRIVATE KEY-----\\n`;

/** Project settings → Service accounts → Generate new private key. */
function adminCredentials(projectId = 'keypad-prod') {
  return {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: `firebase-adminsdk@${projectId}.iam.gserviceaccount.com`,
    FIREBASE_PRIVATE_KEY: fakePrivateKey,
  };
}

/** Project settings → Your apps → SDK setup and configuration. */
function webConfig(projectId = 'keypad-prod') {
  return {
    NEXT_PUBLIC_FIREBASE_API_KEY: 'AIzaSy-test',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${projectId}.firebasestorage.app`,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
    NEXT_PUBLIC_FIREBASE_APP_ID: '1:1234567890:web:abcdef',
  };
}

/**
 * Local development: in-memory data and storage, but real Firebase
 * Authentication — there is no authentication fallback to configure any more.
 */
const localServer = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  DATA_PROVIDER: 'memory',
  STORAGE_PROVIDER: 'memory',
  APP_SECRET: 'a1'.repeat(16),
  ...adminCredentials(),
};

/** A production deployment: every provider on Firebase. */
const firebaseServer = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  DATA_PROVIDER: 'firestore',
  STORAGE_PROVIDER: 'firebase',
  APP_SECRET: 'c3'.repeat(16),
  ...adminCredentials(),
};

type EnvInput = Record<string, string | undefined>;

function issuesFor(server: EnvInput, publicEnv: EnvInput = {}): ConfigIssue[] {
  return collectConfigIssues(
    parseServerEnv(server as NodeJS.ProcessEnv),
    parsePublicEnv(publicEnv as NodeJS.ProcessEnv),
  );
}

function reasons(issues: ConfigIssue[]): string[] {
  return issues.map((issue) => issue.reason);
}

describe('configuration diagnostics', () => {
  it('accepts the documented local development setup', () => {
    expect(issuesFor(localServer, webConfig())).toEqual([]);
  });

  it('accepts a fully configured Firebase deployment', () => {
    expect(issuesFor(firebaseServer, webConfig())).toEqual([]);
  });

  it('explains why sign-up fails when the browser has no Firebase configuration', () => {
    const issues = issuesFor(localServer);
    const issue = issues.find((candidate) => candidate.reason === 'firebase_auth_without_client_config');
    expect(issue?.level).toBe('error');
    // The message must name every missing variable, because this is the
    // misconfiguration behind a bare "complete the Firebase sign-up first".
    for (const key of [
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
    ]) {
      expect(issue?.message).toContain(key);
    }
    expect(issue?.message).toContain('UNAUTHENTICATED');
    // There is no development provider to fall back to, so none is suggested.
    expect(issue?.message).not.toContain('AUTH_PROVIDER');
  });

  it('reports a missing service account even when data and storage are in memory', () => {
    // Verifying a Firebase credential needs the Admin SDK, so this is not
    // conditional on DATA_PROVIDER or STORAGE_PROVIDER any more.
    const issues = issuesFor({ ...localServer, FIREBASE_PRIVATE_KEY: '' }, webConfig());
    const issue = issues.find((candidate) => candidate.reason === 'firebase_admin_credentials_missing');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('Firebase Authentication');
    expect(issue?.message).toContain('FIREBASE_PROJECT_ID');
    expect(issue?.message).toContain('FIREBASE_CLIENT_EMAIL');
    expect(issue?.message).toContain('FIREBASE_PRIVATE_KEY');
  });

  it('flags every Firebase-backed provider that lacks Admin credentials', () => {
    const issues = issuesFor({
      NODE_ENV: 'development',
      APP_ENV: 'development',
      DATA_PROVIDER: 'firestore',
      STORAGE_PROVIDER: 'firebase',
      APP_SECRET: 'a1'.repeat(16),
    });
    const issue = issues.find((candidate) => candidate.reason === 'firebase_admin_credentials_missing');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('DATA_PROVIDER=firestore');
    expect(issue?.message).toContain('STORAGE_PROVIDER=firebase');
    expect(issue?.message).toContain('FIREBASE_PRIVATE_KEY');
    expect(reasons(issues)).toContain('firebase_auth_without_client_config');
  });

  it('treats partially filled Admin credentials as unset', () => {
    const issues = issuesFor({
      ...localServer,
      DATA_PROVIDER: 'firestore',
      FIREBASE_PROJECT_ID: 'keypad-prod',
      FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@keypad-prod.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: undefined,
    });
    expect(reasons(issues)).toContain('firebase_admin_credentials_missing');
  });

  it('rejects the placeholder private key from .env.example', () => {
    const issues = issuesFor(
      {
        ...localServer,
        FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----key-----END PRIVATE KEY-----\n',
      },
      webConfig(),
    );
    const issue = issues.find((candidate) => candidate.reason === 'firebase_private_key_malformed');
    expect(issue?.level).toBe('error');
    // The message has to point at the two ways this happens in practice.
    expect(issue?.message).toContain('Generate new private key');
    expect(issue?.message).toContain('.env.local');
  });

  it('accepts a real key shape with escaped newlines, as dashboards paste it', () => {
    expect(reasons(issuesFor(firebaseServer, webConfig()))).toEqual([]);
  });

  it('flags a service-account client email that is not an email address', () => {
    const issues = issuesFor({ ...firebaseServer, FIREBASE_CLIENT_EMAIL: 'keypad-prod' }, webConfig());
    expect(reasons(issues)).toContain('firebase_client_email_malformed');
  });

  it('flags a browser and an Admin SDK pointed at different projects', () => {
    // A valid Firebase account whose ID token this backend can never verify.
    const issues = issuesFor(localServer, webConfig('keypad-other'));
    const issue = issues.find((candidate) => candidate.reason === 'firebase_project_mismatch');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('NEXT_PUBLIC_FIREBASE_PROJECT_ID');
    expect(issue?.message).toContain('FIREBASE_PROJECT_ID');
  });

  it('refuses fallback providers in a production build', () => {
    const issues = issuesFor(
      { ...localServer, NODE_ENV: 'production', APP_ENV: 'production' },
      webConfig(),
    );
    const fallbacks = issues.filter((candidate) => candidate.reason === 'fallback_provider_in_production');
    // Data and storage only: authentication has no fallback to refuse.
    expect(fallbacks).toHaveLength(2);
    expect(fallbacks.every((issue) => issue.level === 'error')).toBe(true);
    const messages = fallbacks.map((issue) => issue.message).join(' ');
    expect(messages).toContain('DATA_PROVIDER=firestore');
    expect(messages).toContain('STORAGE_PROVIDER=firebase');
    expect(messages).not.toContain('AUTH_PROVIDER');
  });

  it('warns about the published placeholder secret, and errors on it in production', () => {
    const development = issuesFor(
      { ...localServer, APP_SECRET: 'change-me-to-a-32-byte-random-hex' },
      webConfig(),
    );
    expect(development).toHaveLength(1);
    expect(development[0]).toMatchObject({ level: 'warn', reason: 'placeholder_secret' });

    const production = issuesFor(
      { ...firebaseServer, APP_SECRET: 'change-me-to-a-32-byte-random-hex' },
      webConfig(),
    );
    expect(production).toEqual([
      expect.objectContaining({ level: 'error', reason: 'placeholder_secret' }),
    ]);
  });

  it('rejects a short signing secret in production only', () => {
    // 16 characters satisfies the schema minimum but is well below what
    // `openssl rand -hex 32` produces, so it is only refused in production.
    const short = 'a'.repeat(16);
    expect(reasons(issuesFor({ ...localServer, APP_SECRET: short }, webConfig()))).not.toContain('weak_secret');
    expect(reasons(issuesFor({ ...firebaseServer, APP_SECRET: short }, webConfig()))).toContain('weak_secret');
  });

  it('reproduces the reported sign-up failure from a copied .env.example', () => {
    // Providers switched to Firebase, credentials left blank: the exact state
    // that answers /api/v1/auth/register with UNAUTHENTICATED.
    const issues = issuesFor({
      NODE_ENV: 'development',
      APP_ENV: 'production',
      DATA_PROVIDER: 'firestore',
      STORAGE_PROVIDER: 'firebase',
      FIREBASE_PROJECT_ID: '',
      FIREBASE_CLIENT_EMAIL: '',
      FIREBASE_PRIVATE_KEY: '',
      APP_SECRET: 'change-me-to-a-32-byte-random-hex',
    });
    expect(reasons(issues)).toEqual([
      'firebase_auth_without_client_config',
      'firebase_admin_credentials_missing',
      'placeholder_secret',
    ]);
    // APP_ENV=production alone is not a production build (NODE_ENV decides), so
    // the fallback providers are not reported as refused here.
    expect(reasons(issues)).not.toContain('fallback_provider_in_production');
  });
});

describe('reportConfigIssues', () => {
  const WATCHED_KEYS = ['DATA_PROVIDER', 'STORAGE_PROVIDER', 'APP_SECRET'] as const;
  const original = new Map(WATCHED_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetReportedConfigIssues();
    vi.restoreAllMocks();
  });

  function loggedLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('config.issue'));
  }

  it('logs each distinct problem once per process', () => {
    resetReportedConfigIssues();
    process.env.DATA_PROVIDER = 'firestore';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = reportConfigIssues('test');
    const second = reportConfigIssues('test');

    expect(second.length).toBe(first.length);
    expect(first.length).toBeGreaterThan(0);
    expect(loggedLines(error)).toHaveLength(new Set(first.map((issue) => issue.message)).size);
  });

  it('names the variable behind a placeholder signing secret', () => {
    resetReportedConfigIssues();
    process.env.DATA_PROVIDER = 'memory';
    process.env.STORAGE_PROVIDER = 'memory';
    process.env.APP_SECRET = 'change-me-to-a-32-byte-random-hex';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportConfigIssues('test');

    const lines = loggedLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('placeholder_secret');
    expect(lines.join(' ')).toContain('APP_SECRET');
    // The value itself is never logged.
    expect(lines.join(' ')).not.toContain('change-me-to-a-32-byte-random-hex');
  });
});

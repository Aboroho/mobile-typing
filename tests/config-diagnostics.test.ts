import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectConfigIssues,
  parsePublicEnv,
  parseServerEnv,
  type ConfigIssue,
} from '@mt/config';
import { reportConfigIssues, resetReportedConfigIssues } from '@/lib/diagnostics';

/** A working local setup: memory/dev providers, real (non placeholder) secrets. */
const localServer = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  DATA_PROVIDER: 'memory',
  AUTH_PROVIDER: 'dev',
  STORAGE_PROVIDER: 'memory',
  APP_SECRET: 'a1'.repeat(16),
  DEV_SESSION_SECRET: 'b2'.repeat(16),
};

/** Shaped like a real PKCS#8 key: a PEM block with a long base64 body. */
const fakePrivateKey = `-----BEGIN PRIVATE KEY-----\\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(6)}\\n-----END PRIVATE KEY-----\\n`;

/** A complete Firebase project: web config for the browser, service account for the server. */
const firebaseServer = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  DATA_PROVIDER: 'firestore',
  AUTH_PROVIDER: 'firebase',
  STORAGE_PROVIDER: 'firebase',
  FIREBASE_PROJECT_ID: 'keypad-prod',
  FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@keypad-prod.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: fakePrivateKey,
  APP_SECRET: 'c3'.repeat(16),
  DEV_SESSION_SECRET: 'd4'.repeat(16),
};

const firebaseClient = {
  NEXT_PUBLIC_FIREBASE_API_KEY: 'AIzaSy-test',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'keypad-prod.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'keypad-prod',
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'keypad-prod.appspot.com',
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
  NEXT_PUBLIC_FIREBASE_APP_ID: '1:1234567890:web:abcdef',
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
    expect(issuesFor(localServer)).toEqual([]);
  });

  it('accepts a fully configured Firebase deployment', () => {
    expect(issuesFor(firebaseServer, firebaseClient)).toEqual([]);
  });

  it('explains why sign-up fails when Firebase Auth has no browser config', () => {
    const issues = issuesFor({ ...firebaseServer, NODE_ENV: 'development', APP_ENV: 'development' });
    const issue = issues.find((candidate) => candidate.reason === 'firebase_auth_without_client_config');
    expect(issue?.level).toBe('error');
    // The message must name both the missing variables and the local workaround,
    // because this is the misconfiguration behind a bare
    // "complete the Firebase sign-up first" response.
    expect(issue?.message).toContain('NEXT_PUBLIC_FIREBASE_API_KEY');
    expect(issue?.message).toContain('AUTH_PROVIDER=dev');
    expect(issue?.message).toContain('UNAUTHENTICATED');
  });

  it('flags every Firebase-backed provider that lacks Admin credentials', () => {
    const issues = issuesFor({
      ...localServer,
      DATA_PROVIDER: 'firestore',
      AUTH_PROVIDER: 'firebase',
      STORAGE_PROVIDER: 'firebase',
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
    });
    expect(reasons(issues)).toContain('firebase_admin_credentials_missing');
  });

  it('rejects the placeholder private key from .env.example', () => {
    const issues = issuesFor({
      ...localServer,
      AUTH_PROVIDER: 'firebase',
      FIREBASE_PROJECT_ID: 'keypad-prod',
      FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@keypad-prod.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----key-----END PRIVATE KEY-----\n',
    });
    const issue = issues.find((candidate) => candidate.reason === 'firebase_private_key_malformed');
    expect(issue?.level).toBe('error');
    // The message has to point at the two ways this happens in practice.
    expect(issue?.message).toContain('Generate new private key');
    expect(issue?.message).toContain('.env.local');
  });

  it('accepts a real key shape with escaped newlines, as dashboards paste it', () => {
    expect(reasons(issuesFor(firebaseServer, firebaseClient))).toEqual([]);
  });

  it('flags a service-account client email that is not an email address', () => {
    const issues = issuesFor({ ...firebaseServer, FIREBASE_CLIENT_EMAIL: 'keypad-prod' }, firebaseClient);
    expect(reasons(issues)).toContain('firebase_client_email_malformed');
  });

  it('refuses fallback providers in a production build', () => {
    const issues = issuesFor({ ...localServer, NODE_ENV: 'production', APP_ENV: 'production' });
    const fallbacks = issues.filter((candidate) => candidate.reason === 'fallback_provider_in_production');
    expect(fallbacks).toHaveLength(3);
    expect(fallbacks.every((issue) => issue.level === 'error')).toBe(true);
    expect(fallbacks.map((issue) => issue.message).join(' ')).toContain('DATA_PROVIDER=firestore');
  });

  it('warns about the published placeholder secrets, and errors on them in production', () => {
    const development = issuesFor({ ...localServer, APP_SECRET: 'change-me-to-a-32-byte-random-hex' });
    expect(development).toHaveLength(1);
    expect(development[0]).toMatchObject({ level: 'warn', reason: 'placeholder_secret' });

    const production = issuesFor({
      ...firebaseServer,
      DEV_SESSION_SECRET: 'change-me-too-32-byte-random-hex',
    }, firebaseClient);
    expect(production).toEqual([
      expect.objectContaining({ level: 'error', reason: 'placeholder_secret' }),
    ]);
  });

  it('rejects a short signing secret in production only', () => {
    // 16 characters satisfies the schema minimum but is well below what
    // `openssl rand -hex 32` produces, so it is only refused in production.
    const short = 'a'.repeat(16);
    expect(reasons(issuesFor({ ...localServer, APP_SECRET: short }))).not.toContain('weak_secret');
    expect(reasons(issuesFor({ ...firebaseServer, APP_SECRET: short }, firebaseClient))).toContain('weak_secret');
  });

  it('reproduces the reported sign-up failure from a copied .env.example', () => {
    // Providers switched to Firebase, credentials left blank: the exact state
    // that answers /api/v1/auth/register with UNAUTHENTICATED.
    const issues = issuesFor({
      NODE_ENV: 'development',
      APP_ENV: 'production',
      DATA_PROVIDER: 'firestore',
      AUTH_PROVIDER: 'firebase',
      STORAGE_PROVIDER: 'firebase',
      FIREBASE_PROJECT_ID: '',
      FIREBASE_CLIENT_EMAIL: '',
      FIREBASE_PRIVATE_KEY: '',
      APP_SECRET: 'change-me-to-a-32-byte-random-hex',
      DEV_SESSION_SECRET: 'change-me-too-32-byte-random-hex',
    });
    expect(reasons(issues)).toEqual([
      'firebase_auth_without_client_config',
      'firebase_admin_credentials_missing',
      'placeholder_secret',
      'placeholder_secret',
    ]);
    // APP_ENV=production alone is not a production build (NODE_ENV decides), so
    // the fallback providers are not reported as refused here.
    expect(reasons(issues)).not.toContain('fallback_provider_in_production');
  });
});

describe('reportConfigIssues', () => {
  const WATCHED_KEYS = ['AUTH_PROVIDER', 'DATA_PROVIDER', 'APP_SECRET', 'DEV_SESSION_SECRET'] as const;
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
    process.env.AUTH_PROVIDER = 'firebase';
    process.env.DATA_PROVIDER = 'firestore';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = reportConfigIssues('test');
    const second = reportConfigIssues('test');

    expect(second.length).toBe(first.length);
    expect(first.length).toBeGreaterThan(0);
    expect(loggedLines(error)).toHaveLength(new Set(first.map((issue) => issue.message)).size);
  });

  it('reports one problem per variable even when they share a reason', () => {
    resetReportedConfigIssues();
    process.env.AUTH_PROVIDER = 'dev';
    process.env.DATA_PROVIDER = 'memory';
    process.env.APP_SECRET = 'change-me-to-a-32-byte-random-hex';
    process.env.DEV_SESSION_SECRET = 'change-me-too-32-byte-random-hex';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reportConfigIssues('test');

    const lines = loggedLines(warn);
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('placeholder_secret'))).toHaveLength(2);
    expect(lines.join(' ')).toContain('DEV_SESSION_SECRET');
  });
});

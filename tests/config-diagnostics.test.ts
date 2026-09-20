import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectConfigIssues,
  parsePublicEnv,
  parseServerEnv,
  type ConfigIssue,
} from '@mt/config';
import { reportConfigIssues, resetReportedConfigIssues } from '@/lib/diagnostics';

/**
 * Configuration diagnostic tests for the argon2-session / Prisma / object-storage
 * backend (no Firebase).
 */

const localServer = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  DATA_PROVIDER: 'memory',
  STORAGE_PROVIDER: 'memory',
  APP_SECRET: 'a1'.repeat(16),
};

const productionServer = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  DATA_PROVIDER: 'prisma',
  STORAGE_PROVIDER: 'local',
  DATABASE_URL: 'postgres://user:pass@db.internal:5432/keypad',
  STORAGE_LOCAL_DIR: '/var/lib/keypad/media',
  ADMIN_EMAIL: 'admin@example.com',
  APP_SECRET: 'c3'.repeat(16),
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

  it('accepts a fully configured production deployment', () => {
    expect(issuesFor(productionServer)).toEqual([]);
  });

  it('flags incomplete S3 credentials when S3 storage is selected', () => {
    const issues = issuesFor({ ...productionServer, STORAGE_PROVIDER: 's3', STORAGE_BUCKET: '' });
    const issue = issues.find((c) => c.reason === 's3_storage_incomplete');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('STORAGE_BUCKET');
    expect(issue?.message).toContain('STORAGE_ACCESS_KEY');
    expect(issue?.message).toContain('STORAGE_SECRET_KEY');
  });

  it('warns about localhost DATABASE_URL in production', () => {
    const issues = issuesFor({ ...productionServer, DATABASE_URL: 'postgres://user:pass@localhost:5432/keypad' });
    const issue = issues.find((c) => c.reason === 'database_localhost_in_production');
    expect(issue?.level).toBe('warn');
  });

  it('refuses fallback providers in a production build', () => {
    const issues = issuesFor({ ...productionServer, DATA_PROVIDER: 'memory', STORAGE_PROVIDER: 'memory' });
    const fallbacks = issues.filter((c) => c.reason === 'fallback_provider_in_production');
    expect(fallbacks).toHaveLength(2);
    expect(fallbacks.every((i) => i.level === 'error')).toBe(true);
    const message = fallbacks.map((i) => i.message).join(' ');
    expect(message).toContain('DATA_PROVIDER=prisma');
    expect(message).toContain('STORAGE_PROVIDER=local or s3');
  });

  it('warns when no administrator identity is configured in production', () => {
    const issues = issuesFor({ ...productionServer, ADMIN_EMAIL: '', ADMIN_UID: '' });
    expect(reasons(issues)).toContain('admin_not_configured');
  });

  it('warns about the published placeholder secret, and errors on it in production', () => {
    const dev = issuesFor({ ...localServer, APP_SECRET: 'change-me-to-a-32-byte-random-hex' });
    expect(dev).toHaveLength(1);
    expect(dev[0]).toMatchObject({ level: 'warn', reason: 'placeholder_secret' });

    const prod = issuesFor({ ...productionServer, APP_SECRET: 'change-me-to-a-32-byte-random-hex' });
    expect(prod).toEqual([expect.objectContaining({ level: 'error', reason: 'placeholder_secret' })]);
  });

  it('rejects a short signing secret in production only', () => {
    const short = 'a'.repeat(16);
    expect(reasons(issuesFor({ ...localServer, APP_SECRET: short }))).not.toContain('weak_secret');
    expect(reasons(issuesFor({ ...productionServer, APP_SECRET: short }))).toContain('weak_secret');
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
    process.env.DATA_PROVIDER = 'prisma';
    process.env.STORAGE_PROVIDER = 's3';
    // APP_SECRET must pass zod validation (>=16 chars); use the placeholder to trigger a diagnostic.
    process.env.APP_SECRET = 'change-me-to-a-32-byte-random-hex';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = reportConfigIssues('test');
    const second = reportConfigIssues('test');
    expect(second.length).toBe(first.length);
    expect(first.length).toBeGreaterThan(0);
    const all = [...loggedLines(error), ...loggedLines(warn)];
    expect(all).toHaveLength(new Set(first.map((i) => i.message)).size);
  });
});

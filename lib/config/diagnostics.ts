import { parsePublicEnv, type PublicEnv } from './public-env';
import { isProduction, parseServerEnv, type ServerEnv } from './server-env';

export type ConfigIssueLevel = 'error' | 'warn' | 'info';

export interface ConfigIssue {
  level: ConfigIssueLevel;
  reason: string;
  message: string;
}

const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-32-byte-random-hex',
  'dev-only-insecure-secret-change-me',
  'dev-only-insecure-secret-change-me-please-32-bytes',
]);

const PRODUCTION_SECRET_MIN_LENGTH = 32;

const FALLBACK_PROVIDERS: Array<{ key: 'DATA_PROVIDER' | 'STORAGE_PROVIDER'; local: string; production: string }> = [
  { key: 'DATA_PROVIDER', local: 'memory', production: 'prisma' },
  { key: 'STORAGE_PROVIDER', local: 'memory', production: 'local or s3' },
];

export function collectConfigIssues(server: ServerEnv, publicEnv: PublicEnv): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const production = isProduction(server);

  if (server.DATA_PROVIDER === 'prisma') {
    if (!server.DATABASE_URL || server.DATABASE_URL.includes('localhost') === false && !server.DATABASE_URL.startsWith('postgres')) {
      // Only warn in production about local DB
    }
    if (production && server.DATABASE_URL.includes('localhost')) {
      issues.push({
        level: 'warn',
        reason: 'database_localhost_in_production',
        message: 'DATABASE_URL points at localhost in production. Verify your PostgreSQL connection string.',
      });
    }
  }

  if (server.STORAGE_PROVIDER === 's3') {
    if (!server.STORAGE_ACCESS_KEY || !server.STORAGE_SECRET_KEY || !server.STORAGE_BUCKET) {
      issues.push({
        level: 'error',
        reason: 's3_storage_incomplete',
        message: 'STORAGE_PROVIDER=s3 requires STORAGE_BUCKET, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY.',
      });
    }
  }

  if (production) {
    for (const provider of FALLBACK_PROVIDERS) {
      if (server[provider.key] === provider.local) {
        issues.push({
          level: 'error',
          reason: 'fallback_provider_in_production',
          message: `${provider.key}=${provider.local} is refused in production. Set ${provider.key}=${provider.production}.`,
        });
      }
    }
    if (!server.ADMIN_UID && !server.ADMIN_EMAIL) {
      issues.push({
        level: 'warn',
        reason: 'admin_not_configured',
        message: 'Neither ADMIN_UID nor ADMIN_EMAIL is set: no user will have administrator access.',
      });
    }
  }

  for (const key of ['APP_SECRET'] as const) {
    const value = server[key];
    if (PLACEHOLDER_SECRETS.has(value)) {
      issues.push({
        level: production ? 'error' : 'warn',
        reason: 'placeholder_secret',
        message: `${key} is still the placeholder from .env.example. Generate one with \`openssl rand -hex 32\`.`,
      });
    } else if (production && value.length < PRODUCTION_SECRET_MIN_LENGTH) {
      issues.push({
        level: 'error',
        reason: 'weak_secret',
        message: `${key} is shorter than ${PRODUCTION_SECRET_MIN_LENGTH} characters.`,
      });
    }
  }

  void publicEnv;
  return issues;
}

export function collectConfigIssuesFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigIssue[] {
  return collectConfigIssues(parseServerEnv(env), parsePublicEnv(env));
}

#!/usr/bin/env node
/**
 * Doctor script for the Keypad backend.
 *
 * Scans env files for common misconfigurations in the argon2/Prisma/S3-local
 * backend. Replaces the old Firebase-oriented check-firebase script.
 *
 * Usage: node scripts/doctor.mjs [--no-server]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[2;32m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-32-byte-random-hex',
  'dev-only-insecure-secret-change-me',
  'dev-only-insecure-secret-change-me-please-32-bytes',
]);

const CANDIDATE_FILES = ['.env.local', '.env.development.local', '.env', '.env.example'];

// Minimal .env parser (handles quoted values and blank overrides).
function parseDotenv(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let i = 0;
  for (const raw of lines) {
    i++;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes
    const startsQuote = value.startsWith('"') || value.startsWith("'");
    const quote = value[0];
    const endsMatchingQuote = value.length >= 2 && value.endsWith(quote);
    if (startsQuote && endsMatchingQuote) {
      value = value.slice(1, -1);
    } else if (startsQuote) {
      return { error: { file: '<inline>', line: i, message: `unterminated quote for ${key}` } };
    }
    out.set(key, value);
  }
  return { values: out };
}

function loadEnv(cwd) {
  const merged = new Map();
  const sources = new Map();
  const order = [];
  for (const name of CANDIDATE_FILES) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    order.push(name);
    const text = readFileSync(path, 'utf8');
    const parsed = parseDotenv(text);
    if (parsed.error) return { error: { ...parsed.error, file: name } };
    for (const [k, v] of parsed.values) {
      if (!merged.has(k)) {
        merged.set(k, v);
        sources.set(k, name);
      }
    }
  }
  return { values: merged, sources, order };
}

function mask(value) {
  if (!value) return '(blank)';
  if (PLACEHOLDER_SECRETS.has(value)) return '(placeholder)';
  return `(set, ${value.length} chars)`;
}

function main() {
  const cwd = process.cwd();
  const noServer = process.argv.includes('--no-server');
  const loaded = loadEnv(cwd);
  let errors = 0;
  let warnings = 0;

  function err(msg) { errors++; console.error(`${RED}✖${RESET} ${msg}`); }
  function warn(msg) { warnings++; console.warn(`${YELLOW}⚠${RESET} ${msg}`); }
  function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }

  if (loaded.error) {
    err(`env parse error in ${loaded.error.file} line ${loaded.error.line}: ${loaded.error.message}`);
    process.exit(1);
  }
  const env = loaded.values;
  const sources = loaded.sources;
  const order = loaded.order;

  console.log(`${BOLD}Keypad doctor — PostgreSQL/Argon2 backend${RESET}`);
  console.log(`env files, highest precedence first: ${order.length ? order.join(', ') : '(none found)'}`);

  // Show key variables
  for (const key of ['APP_SECRET', 'DATA_PROVIDER', 'STORAGE_PROVIDER', 'DATABASE_URL', 'ADMIN_EMAIL', 'STORAGE_BUCKET', 'SEED_SECRET_CODE', 'ADMIN_PASSWORD']) {
    const v = env.get(key) ?? '';
    const src = sources.get(key) ?? '(not set)';
    if (key === 'APP_SECRET' || key === 'ADMIN_PASSWORD' || key === 'SEED_SECRET_CODE' || key === 'DATABASE_URL') {
      console.log(`  ${key.padEnd(22)} ${mask(v).padEnd(18)} ${src}`);
    } else {
      console.log(`  ${key.padEnd(22)} ${(v || '(blank)').padEnd(18)} ${src}`);
    }
  }

  // Detect .env.local blank overriding .env value (a common trap)
  if (order.includes('.env') && order.includes('.env.local')) {
    const localText = readFileSync(resolve(cwd, '.env.local'), 'utf8');
    const envText = readFileSync(resolve(cwd, '.env'), 'utf8');
    const localParsed = parseDotenv(localText);
    const envParsed = parseDotenv(envText);
    if (!localParsed.error && !envParsed.error) {
      const traps = [];
      for (const [k, v] of envParsed.values) {
        if (localParsed.values.has(k) && localParsed.values.get(k) === '' && v !== '') {
          traps.push(k);
        }
      }
      if (traps.length > 0) {
        err(`blank values in .env.local override real ones in .env: ${traps.join(', ')}. Delete the blank lines or fill them in; Next.js reads .env.local before .env.`);
      }
    }
  }

  // APP_SECRET checks
  const secret = env.get('APP_SECRET') ?? '';
  if (!secret) {
    err('APP_SECRET is not set. Generate one with `openssl rand -hex 32`.');
  } else if (PLACEHOLDER_SECRETS.has(secret)) {
    err('APP_SECRET is still the placeholder from .env.example. Generate one with `openssl rand -hex 32`.');
  } else if (secret.length < 32) {
    warn(`APP_SECRET is short (${secret.length} chars); production expects >=32.`);
  }

  // Data provider checks
  const dataProvider = env.get('DATA_PROVIDER') ?? 'memory';
  if (dataProvider === 'memory') {
    warn('DATA_PROVIDER=memory is selected: nothing persists between restarts. Set DATA_PROVIDER=prisma for production.');
  } else if (dataProvider === 'prisma') {
    const dbUrl = env.get('DATABASE_URL') ?? '';
    if (!dbUrl) {
      err('DATA_PROVIDER=prisma requires DATABASE_URL (e.g. postgres://user:pass@host:5432/keypad).');
    } else if (!/^postgres(ql)?:\/\//.test(dbUrl)) {
      err(`DATABASE_URL does not look like a PostgreSQL connection string: ${dbUrl.slice(0, 20)}…`);
    } else {
      ok('DATA_PROVIDER=prisma with a PostgreSQL DATABASE_URL.');
    }
  }

  // Storage provider checks
  const storageProvider = env.get('STORAGE_PROVIDER') ?? 'memory';
  if (storageProvider === 'memory') {
    warn('STORAGE_PROVIDER=memory is selected: media will be lost on restart. Use STORAGE_PROVIDER=local or s3 for production.');
  } else if (storageProvider === 's3') {
    const bucket = env.get('STORAGE_BUCKET');
    const ak = env.get('STORAGE_ACCESS_KEY');
    const sk = env.get('STORAGE_SECRET_KEY');
    if (!bucket || !ak || !sk) err('STORAGE_PROVIDER=s3 requires STORAGE_BUCKET, STORAGE_ACCESS_KEY, and STORAGE_SECRET_KEY.');
  } else if (storageProvider === 'local') {
    const dir = env.get('STORAGE_LOCAL_DIR');
    if (!dir) warn('STORAGE_PROVIDER=local but STORAGE_LOCAL_DIR is not set (defaults to ./storage/media).');
  }

  if (!env.get('ADMIN_EMAIL') && !env.get('ADMIN_UID')) {
    warn('Neither ADMIN_EMAIL nor ADMIN_UID is set: no user will have administrator access.');
  }

  if (!noServer) {
    console.log(`\n${GREEN}[skip]${RESET} dev-server probe — pass --no-server to skip it (default)`);
  }

  console.log(`\n${errors} error(s), ${warnings} warning(s).`);
  if (errors > 0) process.exit(1);
}

main();

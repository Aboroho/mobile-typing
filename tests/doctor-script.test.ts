import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `npm run doctor` exists to answer "is my Firebase setup actually usable?"
 * without a browser and without a failed request to interpret. These tests run
 * it against throwaway env files in a temporary directory: the value of the
 * script is precisely what it reports about them, and every check here is
 * offline (the network probes are skipped whenever credentials are incomplete,
 * and `--no-server` avoids the dev-server comparison).
 */

const run = promisify(execFile);
const SCRIPT = resolve(process.cwd(), 'scripts/check-firebase.mjs');

/**
 * A minimal environment: the script reads `process.env` before any file, so an
 * inherited `DATA_PROVIDER` or credential would hide what a fixture is testing.
 * `NODE_ENV` is pinned because it decides which `.env.*` files are read.
 */
const CLEAN_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  NODE_ENV: 'development' as const,
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function doctor(files: Record<string, string>, args: string[] = ['--no-server']) {
  const dir = await mkdtemp(join(tmpdir(), 'keypad-doctor-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents);
  }
  const result = await run(process.execPath, [SCRIPT, ...args], { cwd: dir, env: CLEAN_ENV }).then(
    (value) => ({ code: 0, output: `${value.stdout}${value.stderr}` }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }),
  );
  return result;
}

describe('doctor script', () => {
  it('reports credentials in .env that a blank .env.local overrides', async () => {
    const result = await doctor({
      '.env': [
        'DATA_PROVIDER=firestore',
        'STORAGE_PROVIDER=firebase',
        'NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy-real-key',
        'FIREBASE_PROJECT_ID=keypad-prod',
        'FIREBASE_CLIENT_EMAIL=firebase-adminsdk-x@keypad-prod.iam.gserviceaccount.com',
        '',
      ].join('\n'),
      '.env.local': ['NEXT_PUBLIC_FIREBASE_API_KEY=""', 'FIREBASE_PROJECT_ID=""', ''].join('\n'),
    });

    expect(result.code).toBe(1);
    // The precedence trap is named first, with both files and the fix.
    expect(result.output).toContain('override real ones');
    expect(result.output).toContain('NEXT_PUBLIC_FIREBASE_API_KEY (real value in .env)');
    expect(result.output).toContain('FIREBASE_PROJECT_ID (real value in .env)');
    expect(result.output).toContain('.env.local before .env');
    // The table shows where every value actually came from.
    expect(result.output).toContain('env files, highest precedence first: .env.local, .env');
    expect(result.output).toMatch(/NEXT_PUBLIC_FIREBASE_API_KEY\s+\(blank\)\s+\.env\.local/);
    expect(result.output).toMatch(/DATA_PROVIDER\s+firestore\s+\.env/);
  });

  it('flags an unterminated quote instead of treating it as a value', async () => {
    const result = await doctor({
      '.env.local': ['NEXT_PUBLIC_FIREBASE_PROJECT_ID="', ''].join('\n'),
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('unterminated quote');
    expect(result.output).toContain('NEXT_PUBLIC_FIREBASE_PROJECT_ID');
  });

  it('rejects the placeholder private key from .env.example', async () => {
    const result = await doctor({
      '.env.local': [
        'DATA_PROVIDER=firestore',
        'STORAGE_PROVIDER=firebase',
        'NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy-real-key',
        'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=keypad-prod.firebaseapp.com',
        'NEXT_PUBLIC_FIREBASE_PROJECT_ID=keypad-prod',
        'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=1234567890',
        'NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:abc',
        'FIREBASE_PROJECT_ID=keypad-prod',
        'FIREBASE_CLIENT_EMAIL=firebase-adminsdk-x@keypad-prod.iam.gserviceaccount.com',
        'FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----key-----END PRIVATE KEY-----\\n"',
        '',
      ].join('\n'),
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('FIREBASE_PRIVATE_KEY is not a usable key');
    expect(result.output).toContain('base64 body 3 chars');
    // The secret itself is never echoed, only its length.
    expect(result.output).toMatch(/FIREBASE_PRIVATE_KEY\s+\(set, 56 chars\)/);
    expect(result.output).not.toContain('BEGIN PRIVATE KEY-----key');
  });

  it('says plainly that nothing is stored in Firebase while the dev providers are selected', async () => {
    const result = await doctor({
      '.env.local': ['DATA_PROVIDER=memory', 'STORAGE_PROVIDER=memory', ''].join('\n'),
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('nothing is stored in Firebase until this is firestore');
    expect(result.output).toContain('nothing is stored in Firebase until this is firebase');
    // No credentials to work with, so the network probes are skipped, not failed.
    expect(result.output).toContain('[skip] Firestore — the Admin SDK did not initialise');
    expect(result.output).toContain('[skip] Storage — the Admin SDK did not initialise');
  });

  it('skips the Auth probe on request and never prints a secret value', async () => {
    const result = await doctor(
      {
        '.env.local': [
          'DATA_PROVIDER=memory',
          'STORAGE_PROVIDER=memory',
          'SEED_SECRET_CODE=opensesame',
          'ADMIN_PASSWORD=hunter2hunter2',
          '',
        ].join('\n'),
      },
      ['--no-server', '--no-signup'],
    );

    expect(result.output).toContain('[skip] Firebase Auth sign-up probe — --no-signup given');
    expect(result.output).toContain('SEED_SECRET_CODE');
    expect(result.output).not.toContain('opensesame');
    expect(result.output).not.toContain('hunter2hunter2');
  });
});

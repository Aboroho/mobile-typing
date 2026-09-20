import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for `npm run doctor` (scripts/doctor.mjs) against throwaway env files.
 */

const run = promisify(execFile);
const SCRIPT = resolve(process.cwd(), 'scripts/doctor.mjs');

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
  it('reports blank overrides in .env.local that shadow real .env values', async () => {
    const result = await doctor({
      '.env': [
        'DATA_PROVIDER=prisma',
        'STORAGE_PROVIDER=s3',
        'APP_SECRET=aa'.repeat(16),
        'DATABASE_URL=postgres://u:p@db:5432/keypad',
        'STORAGE_BUCKET=keypad-media',
        '',
      ].join('\n'),
      '.env.local': ['DATA_PROVIDER=""', 'STORAGE_BUCKET=""', ''].join('\n'),
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('override real ones');
    expect(result.output).toContain('DATA_PROVIDER');
    expect(result.output).toContain('STORAGE_BUCKET');
    expect(result.output).toContain('.env.local before .env');
    expect(result.output).toContain('.env.local');
  });

  it('flags an unterminated quote', async () => {
    const result = await doctor({
      '.env.local': ['APP_SECRET="', ''].join('\n'),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('unterminated quote');
  });

  it('rejects the placeholder APP_SECRET from .env.example', async () => {
    const result = await doctor({
      '.env.local': [
        'DATA_PROVIDER=prisma',
        'STORAGE_PROVIDER=local',
        'DATABASE_URL=postgres://u:p@db:5432/keypad',
        'APP_SECRET=change-me-to-a-32-byte-random-hex',
        '',
      ].join('\n'),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('APP_SECRET is still the placeholder');
    expect(result.output).not.toContain('change-me-to-a-32-byte-random-hex'); // only described, not echoed inline?
  });

  it('warns that memory providers persist nothing', async () => {
    const result = await doctor({
      '.env.local': ['DATA_PROVIDER=memory', 'STORAGE_PROVIDER=memory', `APP_SECRET=${'a1'.repeat(16)}`, ''].join('\n'),
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('DATA_PROVIDER=memory');
    expect(result.output).toContain('STORAGE_PROVIDER=memory');
    expect(result.output).toContain('nothing persists');
  });

  it('never prints secret values in the variable table', async () => {
    const result = await doctor(
      {
        '.env.local': [
          'DATA_PROVIDER=memory',
          'STORAGE_PROVIDER=memory',
          `APP_SECRET=${'bb'.repeat(16)}`,
          'SEED_SECRET_CODE=opensesame',
          'ADMIN_PASSWORD=hunter2hunter2',
          'DATABASE_URL=postgres://u:p@db:5432/keypad',
          '',
        ].join('\n'),
      },
      ['--no-server'],
    );
    expect(result.output).toContain('SEED_SECRET_CODE');
    expect(result.output).not.toContain('opensesame');
    expect(result.output).not.toContain('hunter2hunter2');
  });
});

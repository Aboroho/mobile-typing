import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `npm run seed` must create its accounts the way the browser does: through
 * Firebase Authentication, presenting the resulting ID token to an API that
 * accepts nothing else. The failure this guards against is the bare 401
 * "complete the Firebase sign-up first" that a password-only request receives.
 *
 * Both servers below are stand-ins: a fake Identity Toolkit, and a fake Keypad
 * API that enforces the same bearer-token rule the real one does.
 */

const run = promisify(execFile);

interface Stub {
  url: string;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<Stub> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => resolve(body));
  });
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
  cookies: string[] = [],
): void {
  const headers: Record<string, string | string[]> = { 'Content-Type': 'application/json' };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

/** Identity Toolkit stand-in: signUp / signInWithPassword against an in-memory map. */
async function startIdentityStub() {
  const users = new Map<string, string>();
  const calls: string[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const payload = JSON.parse(body || '{}') as { email: string; password: string };
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const operation = pathname.split('/').pop()?.replace('accounts:', '') ?? '';
      calls.push(operation);
      if (!/key=./.test(request.url ?? '')) {
        return json(response, 403, { error: { message: 'API key not valid.' } });
      }
      if (operation === 'signUp') {
        if (users.has(payload.email)) {
          return json(response, 400, { error: { message: 'EMAIL_EXISTS' } });
        }
        users.set(payload.email, payload.password);
        return json(response, 200, {
          idToken: `id-token-${payload.email}`,
          localId: payload.email,
        });
      }
      if (operation === 'signInWithPassword') {
        if (users.get(payload.email) !== payload.password) {
          return json(response, 400, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } });
        }
        return json(response, 200, {
          idToken: `id-token-${payload.email}`,
          localId: payload.email,
        });
      }
      return json(response, 400, { error: { message: 'UNSUPPORTED' } });
    });
  });
  return { ...(await listen(server)), calls };
}

/** Keypad API stand-in, enforcing the Bearer-ID-token rule of the firebase provider. */
async function startApiStub() {
  const uids = new Map<string, string>();
  const authHeaders: (string | null)[] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const payload = JSON.parse(body || '{}') as { email?: string; name?: string };
      const bearer = request.headers.authorization ?? null;
      paths.push(path);

      if (path === '/api/v1/health') {
        return json(response, 200, {
          ok: true,
          data: { dataProvider: 'memory', authProvider: 'firebase' },
        });
      }
      if (path === '/api/v1/access/challenge') {
        return json(
          response,
          200,
          { ok: true, data: { challenge: { challengeToken: 'challenge-1', code: 'opensesame' } } },
          ['mt_access=challenge; Path=/'],
        );
      }
      if (path === '/api/v1/access/unlock') {
        return json(response, 200, { ok: true, data: { unlocked: true } }, [
          'mt_access=session; Path=/',
        ]);
      }
      if (path === '/api/v1/auth/register' || path === '/api/v1/auth/login') {
        authHeaders.push(bearer);
        if (!bearer?.startsWith('Bearer id-token-')) {
          // Exactly what the real API returns to a password-only request.
          return json(response, 401, {
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'complete the Firebase sign-up first' },
          });
        }
        const email = String(payload.email);
        if (path.endsWith('/register')) {
          if (uids.has(email)) {
            return json(response, 409, {
              ok: false,
              error: { code: 'CONFLICT', message: 'that account already exists' },
            });
          }
          uids.set(email, `uid-${email}`);
        }
        uids.set(email, uids.get(email) ?? `uid-${email}`);
        return json(response, 200, {
          ok: true,
          data: {
            user: {
              id: uids.get(email),
              email,
              name: payload.name ?? 'Administrator',
              isAdmin: email === 'admin@example.com',
            },
          },
        });
      }
      return json(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: path } });
    });
  });
  return { ...(await listen(server)), uids, authHeaders, paths };
}

async function runSeed(env: Record<string, string>) {
  return run(process.execPath, ['scripts/seed-dev.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'ChangeMe123!',
      SEED_PEER_EMAIL: 'peer@example.com',
      SEED_SECRET_CODE: 'opensesame',
      ...env,
    },
  }).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  );
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe('seed script', () => {
  it('seeds accounts with a Firebase ID token', async () => {
    const identity = await startIdentityStub();
    const api = await startApiStub();
    cleanup.push(identity.close, api.close);

    const result = await runSeed({
      BASE_URL: api.url,
      FIREBASE_IDENTITY_BASE_URL: `${identity.url}/v1`,
      NEXT_PUBLIC_FIREBASE_API_KEY: 'test-web-api-key',
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('auth: firebase');
    expect(result.stdout).toContain(
      'created admin@example.com -> uid uid-admin@example.com (ADMIN)',
    );
    expect(result.stdout).toContain('created peer@example.com');
    // The whole point: registration carried an ID token, not just a password.
    expect(api.authHeaders).toEqual([
      'Bearer id-token-admin@example.com',
      'Bearer id-token-peer@example.com',
    ]);
  });

  it('reports already-present accounts instead of registering them again', async () => {
    const identity = await startIdentityStub();
    const api = await startApiStub();
    cleanup.push(identity.close, api.close);
    const env = {
      BASE_URL: api.url,
      FIREBASE_IDENTITY_BASE_URL: `${identity.url}/v1`,
      NEXT_PUBLIC_FIREBASE_API_KEY: 'test-web-api-key',
    };

    await runSeed(env);
    api.authHeaders.length = 0;
    api.paths.length = 0;
    const second = await runSeed(env);

    expect(second.stderr).toBe('');
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(
      'already present admin@example.com -> uid uid-admin@example.com (ADMIN)',
    );
    expect(identity.calls).toContain('signInWithPassword');
    // Re-runs must not burn the 5-per-10-minutes registration rate limit.
    expect(api.paths.filter((path) => path === '/api/v1/auth/register')).toHaveLength(0);
  });

  it('explains the missing Web API key instead of failing with a bare 401', async () => {
    const api = await startApiStub();
    cleanup.push(api.close);

    const result = await runSeed({ BASE_URL: api.url, NEXT_PUBLIC_FIREBASE_API_KEY: '' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Firebase ID token');
    expect(result.stderr).toContain('NEXT_PUBLIC_FIREBASE_API_KEY');
    // Nothing was registered, so there are no misleading "skipped" lines.
    expect(api.paths).not.toContain('/api/v1/auth/register');
  });
});

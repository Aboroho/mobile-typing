import { createHash } from 'node:crypto';
import { POST as challengeRoute } from '@/app/api/v1/access/challenge/route';
import { POST as unlockRoute } from '@/app/api/v1/access/unlock/route';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';

/** A route handler as Next.js exposes it: `params` is typed per route. */
export type Handler<P = Record<string, string>> = (
  request: Request,
  context?: { params: P },
) => Promise<Response>;

export interface ApiResult<T = unknown> {
  status: number;
  body: { ok: boolean; data?: T; error?: { code: string; message: string } };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Calls a real route handler the way Next.js would, with a plain Request. */
export async function call<T = unknown>(
  handler: Handler<never>,
  request: Request,
  params?: Record<string, string>,
): Promise<ApiResult<T>> {
  // The route declares its own `params` shape; from the outside every dynamic
  // segment is just a string, so the cast is what keeps one helper for all 51
  // routes without losing the per-route typing in the app itself.
  const response = await handler(
    request,
    params ? ({ params } as unknown as { params: never }) : undefined,
  );
  const body = (await response.json()) as ApiResult<T>['body'];
  return { status: response.status, body };
}

export interface Jar {
  cookies: Record<string, string>;
  header(): string;
}

export function jar(): Jar {
  const cookies: Record<string, string> = {};
  return {
    cookies,
    header() {
      return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    },
  };
}

/** Absorbs Set-Cookie headers, the way a browser would. */
export function absorb(response: Response, target: Jar): void {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '') delete target.cookies[name];
    else target.cookies[name] = value;
  }
}

export function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  target?: Jar,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(target ? { Cookie: target.header() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function queryRequest(
  method: string,
  path: string,
  query?: Record<string, string | number | undefined>,
  target?: Jar,
): Request {
  const url = new URL(`http://localhost:3000${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return new Request(url, {
    method,
    headers: target ? { Cookie: target.header() } : {},
  });
}

/** Query params the way Next hands them to a GET handler. */
export function paramsFrom(url: string | Request): Record<string, string> {
  const search = new URL(typeof url === 'string' ? url : url.url).searchParams;
  const result: Record<string, string> = {};
  search.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export const SECRET_CODE = 'opensesame';

/**
 * Completes the typing-game access flow and returns a jar holding the access
 * session cookie. This is the exact sequence the browser performs.
 */
export async function unlockJar(target: Jar = jar()): Promise<Jar> {
  const challengeResponse = await challengeRoute(jsonRequest('POST', '/api/v1/access/challenge', {}, target));
  absorb(challengeResponse, target);
  const challengeBody = (await challengeResponse.json()) as {
    data: { challenge: { challengeToken: string; code: string } };
  };
  const unlockResponse = await unlockRoute(
    jsonRequest(
      'POST',
      '/api/v1/access/unlock',
      {
        challengeToken: challengeBody.data.challenge.challengeToken,
        digest: sha256(challengeBody.data.challenge.code),
      },
      target,
    ),
  );
  absorb(unlockResponse, target);
  if (unlockResponse.status !== 200) {
    throw new Error(`unlock failed: ${unlockResponse.status}`);
  }
  return target;
}

export interface TestUser {
  jar: Jar;
  id: string;
  email: string;
  name: string;
}

/** Unlock + register in one step, returning a ready-to-use session. */
export async function registerUser(options: {
  name: string;
  email: string;
  password?: string;
}): Promise<TestUser> {
  const password = options.password ?? 'CorrectHorse1!';
  const target = await unlockJar();
  const response = await registerRoute(
    jsonRequest(
      'POST',
      '/api/v1/auth/register',
      {
        name: options.name,
        email: options.email,
        password,
        confirmPassword: password,
      },
      target,
    ),
  );
  absorb(response, target);
  const body = (await response.json()) as {
    data?: { user: { id: string; email: string; name: string; isAdmin: boolean }; accessGranted: boolean };
    error?: { message: string };
  };
  if (response.status !== 201 || !body.data) {
    throw new Error(`register failed (${response.status}): ${body.error?.message ?? 'unknown'}`);
  }
  return { jar: target, id: body.data.user.id, email: body.data.user.email, name: body.data.user.name };
}

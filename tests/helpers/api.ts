import { createHash } from 'node:crypto';
import { POST as challengeRoute } from '@/app/api/v1/access/challenge/route';
import { POST as unlockRoute } from '@/app/api/v1/access/unlock/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as reauthenticateRoute } from '@/app/api/v1/auth/reauthenticate/route';
import { fakeAdminAuth } from './firebase-auth';

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

/**
 * A browser's credentials: the cookies it holds plus the Firebase ID token the
 * client SDK would attach as `Authorization: Bearer`.
 */
export interface Jar {
  cookies: Record<string, string>;
  token: string | null;
  header(): string;
}

export function jar(token: string | null = null): Jar {
  const cookies: Record<string, string> = {};
  return {
    cookies,
    token,
    header() {
      return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    },
  };
}

/**
 * Keeps only the httpOnly session cookie, the way an `EventSource` request does
 * (it cannot set an `Authorization` header). Used to prove the session cookie
 * alone authorises a request.
 */
export function cookieOnly(target: Jar): Jar {
  target.token = null;
  return target;
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

function headersFor(target: Jar | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (!target) return headers;
  const cookie = target.header();
  if (cookie) headers.Cookie = cookie;
  if (target.token) headers.Authorization = `Bearer ${target.token}`;
  return headers;
}

export function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  target?: Jar,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: headersFor(target, { 'Content-Type': 'application/json' }),
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
  return new Request(url, { method, headers: headersFor(target) });
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
  /** Application user id — the Firebase uid. */
  id: string;
  email: string;
  name: string;
  password: string;
  /** The Firebase uid, so tests can compare it with the application id. */
  uid: string;
}

interface AuthResponse {
  data?: {
    user: { id: string; email: string; name: string; isAdmin: boolean };
    accessGranted: boolean;
    token?: string | null;
    cookieSession?: boolean;
  };
  error?: { code: string; message: string };
}

/**
 * Unlock + register, in the order the browser does it:
 * Firebase creates the account and returns an ID token, then the API turns that
 * verified identity into an application profile and a session cookie.
 */
export async function registerUser(options: {
  name: string;
  email: string;
  password?: string;
}): Promise<TestUser> {
  const password = options.password ?? 'CorrectHorse1!';
  const target = await unlockJar();
  const { uid, idToken } = fakeAdminAuth.signUpWithPassword({
    email: options.email,
    password,
    displayName: options.name,
  });
  target.token = idToken;

  const response = await registerRoute(
    jsonRequest(
      'POST',
      '/api/v1/auth/register',
      // The body carries no password: Firebase already verified it in the browser.
      { name: options.name, email: options.email },
      target,
    ),
  );
  absorb(response, target);
  const body = (await response.json()) as AuthResponse;
  if (response.status !== 201 || !body.data) {
    throw new Error(`register failed (${response.status}): ${body.error?.message ?? 'unknown'}`);
  }
  return {
    jar: target,
    id: body.data.user.id,
    email: body.data.user.email,
    name: body.data.user.name,
    password,
    uid,
  };
}

/** Unlock + sign in with Firebase, then open the application session. */
export async function loginUser(options: {
  email: string;
  password?: string;
  target?: Jar;
}): Promise<TestUser> {
  const password = options.password ?? 'CorrectHorse1!';
  const target = options.target ?? (await unlockJar());
  const { uid, idToken } = fakeAdminAuth.signInWithPassword(options.email, password);
  target.token = idToken;

  const response = await loginRoute(
    jsonRequest('POST', '/api/v1/auth/login', { email: options.email }, target),
  );
  absorb(response, target);
  const body = (await response.json()) as AuthResponse;
  if (response.status !== 200 || !body.data) {
    throw new Error(`login failed (${response.status}): ${body.error?.message ?? 'unknown'}`);
  }
  return {
    jar: target,
    id: body.data.user.id,
    email: body.data.user.email,
    name: body.data.user.name,
    password,
    uid,
  };
}

/**
 * The third access branch: prove the password again to Firebase, then bind the
 * access session. Refreshes the jar's ID token, as the browser SDK would.
 */
export async function reauthenticateUser(user: TestUser, password: string = user.password): Promise<void> {
  const { idToken } = fakeAdminAuth.reauthenticateWithPassword(user.uid, password);
  user.jar.token = idToken;
  const response = await reauthenticateRoute(
    jsonRequest('POST', '/api/v1/auth/reauthenticate', {}, user.jar),
  );
  absorb(response, user.jar);
  if (response.status !== 200) {
    throw new Error(`reauthenticate failed: ${response.status}`);
  }
}

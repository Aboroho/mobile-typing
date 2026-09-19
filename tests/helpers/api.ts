/**
 * Integration-test helper that exercises Next.js route handlers directly,
 * without starting an HTTP server. Authentication is cookie-based (Argon2id
 * sessions) so a Jar just carries Set-Cookie values between calls.
 */
import { createHash } from 'node:crypto';
import { POST as challengeRoute } from '@/app/api/v1/access/challenge/route';
import { POST as unlockRoute } from '@/app/api/v1/access/unlock/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as reauthenticateRoute } from '@/app/api/v1/auth/reauthenticate/route';
import { resetDataProvider, resetStore } from '@/lib/data';
import { resetMemoryStorage } from '@/lib/storage';
import { resetReportedConfigIssues } from '@/lib/diagnostics';
import { resetEnvCache } from '@/lib/env';
import { resetAuthClient } from '@/lib/client/auth-client';

/** A route handler as Next.js exposes it. */
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

export async function call<T = unknown>(
  handler: Handler<never>,
  request: Request,
  params?: Record<string, string>,
): Promise<ApiResult<T>> {
  const response = await handler(request, params ? ({ params } as unknown as { params: never }) : undefined);
  const body = (await response.json()) as ApiResult<T>['body'];
  return { status: response.status, body };
}

export interface Jar {
  cookies: Record<string, string>;
  header(): string;
}

export function jar(): Jar {
  return { cookies: {}, header() { return Object.entries(this.cookies).map(([n, v]) => `${n}=${v}`).join('; '); } };
}

export function cookieOnly(target: Jar): Jar { return target; }

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
  return headers;
}

export function jsonRequest(method: string, path: string, body?: unknown, target?: Jar): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: headersFor(target, { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function queryRequest(method: string, path: string, query?: Record<string, string | number | undefined>, target?: Jar): Request {
  const url = new URL(`http://localhost:3000${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return new Request(url, { method, headers: headersFor(target) });
}

export function paramsFrom(url: string | Request): Record<string, string> {
  const search = new URL(typeof url === 'string' ? url : url.url).searchParams;
  const result: Record<string, string> = {};
  search.forEach((value, key) => { result[key] = value; });
  return result;
}

export const SECRET_CODE = 'opensesame';

/** Reset all in-memory stores between tests. */
export function resetState() {
  resetStore();
  resetDataProvider();
  resetMemoryStorage();
  resetEnvCache();
  resetReportedConfigIssues();
  resetAuthClient();
}

export async function unlockJar(target: Jar = jar()): Promise<Jar> {
  const challengeResponse = await challengeRoute(jsonRequest('POST', '/api/v1/access/challenge', {}, target));
  absorb(challengeResponse, target);
  const challengeBody = (await challengeResponse.json()) as { data: { challenge: { challengeToken: string; code: string } } };
  const unlockResponse = await unlockRoute(
    jsonRequest('POST', '/api/v1/access/unlock', {
      challengeToken: challengeBody.data.challenge.challengeToken,
      digest: sha256(challengeBody.data.challenge.code),
    }, target),
  );
  absorb(unlockResponse, target);
  if (unlockResponse.status !== 200) throw new Error(`unlock failed: ${unlockResponse.status}`);
  return target;
}

export interface TestUser {
  jar: Jar;
  id: string;
  email: string;
  name: string;
  password: string;
}

interface AuthResponse {
  data?: { user: { id: string; email: string; name: string; isAdmin: boolean }; accessGranted: boolean; token?: string | null; cookieSession?: boolean };
  error?: { code: string; message: string };
}

/** Unlock + register (password is sent directly in POST body). */
export async function registerUser(options: { name: string; email: string; password?: string }): Promise<TestUser> {
  const password = options.password ?? 'CorrectHorse1!';
  const target = await unlockJar();
  const response = await registerRoute(
    jsonRequest('POST', '/api/v1/auth/register', { name: options.name, email: options.email, password }, target),
  );
  absorb(response, target);
  const body = (await response.json()) as AuthResponse;
  if (response.status !== 201 || !body.data) {
    throw new Error(`register failed (${response.status}): ${body.error?.message ?? 'unknown'}`);
  }
  return { jar: target, id: body.data.user.id, email: body.data.user.email, name: body.data.user.name, password };
}

/** Unlock + login. */
export async function loginUser(options: { email: string; password?: string; target?: Jar }): Promise<TestUser> {
  const password = options.password ?? 'CorrectHorse1!';
  const target = options.target ?? (await unlockJar());
  const response = await loginRoute(
    jsonRequest('POST', '/api/v1/auth/login', { email: options.email, password }, target),
  );
  absorb(response, target);
  const body = (await response.json()) as AuthResponse;
  if (response.status !== 200 || !body.data) {
    throw new Error(`login failed (${response.status}): ${body.error?.message ?? 'unknown'}`);
  }
  return { jar: target, id: body.data.user.id, email: body.data.user.email, name: body.data.user.name, password };
}

/** Reauthenticate: posts password to /auth/reauthenticate. */
export async function reauthenticateUser(user: TestUser, password: string = user.password): Promise<void> {
  const response = await reauthenticateRoute(
    jsonRequest('POST', '/api/v1/auth/reauthenticate', { password }, user.jar),
  );
  absorb(response, user.jar);
  if (response.status !== 200) throw new Error(`reauthenticate failed: ${response.status}`);
}

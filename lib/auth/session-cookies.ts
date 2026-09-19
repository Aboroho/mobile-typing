/**
 * Session-cookie helpers. Thin wrappers around our database-backed session
 * module plus the access-session JWT cookie (mt_access).
 */
import { NextResponse } from 'next/server';
import { createSession, clearSessionCookie, verifySession, revokeSessionByToken, type CookieInstruction } from './session';
import { issueSessionForUser, verifyAccessSession } from '../access/access-service';
import { getData } from '../data';
import { ACCESS_COOKIE, SESSION_COOKIE } from './types';

export interface EstablishedSession {
  verified: { uid: string; email: string; displayName: string | null; authTime: number; isAdminClaim: boolean; source: 'session-cookie' };
  cookie: CookieInstruction | null;
}

export type { CookieInstruction };

export async function establishSession(
  request: Request,
  _options: { failureMessage?: string; requireFresh?: boolean; userId: string },
): Promise<EstablishedSession> {
  const userAgent = request.headers.get('user-agent');
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const cookie = await createSession({ userId: _options.userId, userAgent, ip });
  return {
    verified: {
      uid: _options.userId,
      email: '',
      displayName: null,
      authTime: Math.floor(Date.now() / 1000),
      isAdminClaim: false,
      source: 'session-cookie',
    },
    cookie,
  };
}

export async function logoutAndClear(token: string | null): Promise<CookieInstruction> {
  if (token) await revokeSessionByToken(token);
  return clearSessionCookie();
}

export { verifySession };

/** Set multiple cookies on a NextResponse (returns the response). */
export function applyCookies(response: NextResponse, cookies: Array<CookieInstruction | null | undefined>): NextResponse {
  for (const c of cookies) {
    if (!c) continue;
    response.cookies.set(c.name, c.value, c.options);
  }
  return response;
}

/**
 * If the request already has an access session (the user entered the code
 * before signing in), re-issue it bound to the now-authenticated user id so
 * the chat UI can open immediately after register/login/reauth.
 */
export async function accessBindingCookie(
  request: Request,
  userId: string,
): Promise<CookieInstruction | null> {
  const header = request.headers.get('cookie') ?? '';
  const existing = readCookie(header, ACCESS_COOKIE);
  if (!existing) return null;
  const session = await verifyAccessSession(existing);
  if (!session) return null;
  const next = await issueSessionForUser(userId, session.epoch);
  return {
    name: ACCESS_COOKIE,
    value: next.token,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Math.floor((new Date(next.expiresAt).getTime() - Date.now()) / 1000),
    },
  };
}

/** Clear the session cookie. Returns the response for chaining. */
export function revokeSessionCookie(response: NextResponse): NextResponse {
  const c = clearSessionCookie();
  response.cookies.set(c.name, c.value, c.options);
  return response;
}

/** Clear the access cookie. Returns the response for chaining. */
export function revokeAccessSession(response: NextResponse): NextResponse {
  response.cookies.set(ACCESS_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return response;
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Ensures unused import is referenced (getData is used implicitly by other services).
void getData;
void SESSION_COOKIE;

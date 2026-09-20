/**
 * Server-side session management.
 *
 * Sessions are persisted through the DataProvider (in-memory for tests/dev,
 * PostgreSQL for production) and identified by a 256-bit random token delivered
 * through an HttpOnly, Secure, SameSite=Lax cookie.
 */
import { cookies } from 'next/headers';
import { env } from '../env';
import { generateToken } from './password';
import { getData } from '../data';
import type { UserRecord } from '../data/types';
import type { ResolvedAuth } from './types';

export const SESSION_COOKIE_NAME = 'mt_session';

export interface VerifiedSession {
  uid: string;
  email: string;
  displayName: string | null;
  sessionId: string;
  authTime: number;
  isAdminClaim: boolean;
  source: 'session-cookie';
}

export interface CookieInstruction {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

function cookieOptions(maxAgeSeconds: number): CookieInstruction['options'] {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function isAdminUser(user: Pick<UserRecord, 'id' | 'email'>): boolean {
  const e = env();
  const adminUid = e.ADMIN_UID ?? '';
  const adminEmail = (e.ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (adminUid && user.id === adminUid) return true;
  if (adminEmail && user.email.trim().toLowerCase() === adminEmail) return true;
  return false;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export async function createSession(input: {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<CookieInstruction> {
  const token = generateToken(32);
  const durationHours = env().SESSION_DURATION_HOURS;
  const maxAgeMs = durationHours * 60 * 60 * 1000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + maxAgeMs);
  const tokenHash = await sha256Hex(token);
  const data = await getData();
  await data.sessions.create({
    id: newId('sess'),
    userId: input.userId,
    tokenHash,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
    createdAt: now,
    lastActiveAt: now,
    expiresAt,
  });
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    options: cookieOptions(Math.floor(maxAgeMs / 1000)),
  };
}

/**
 * Credential extraction that works for both shapes this codebase hands in:
 * a WHATWG `Request` (API routes, whose `headers` is a `Headers` object) and a
 * Node `IncomingMessage` (the WebSocket upgrade, whose `headers` is a plain
 * object). Treating the latter as a `Request` silently yields no token, which
 * is how every authenticated socket used to be rejected with 401.
 */
function readCredential(
  request: Request | { headers: Record<string, string | string[] | undefined> },
): string | null {
  const headers = request.headers as Headers | Record<string, string | string[] | undefined>;
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name);
    }
    const value = (headers as Record<string, string | string[] | undefined>)[name];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };

  const auth = get('authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return readCookieFromHeader(get('cookie') ?? '', SESSION_COOKIE_NAME);
}

export async function verifySession(
  request?: Request | { headers: Record<string, string | string[] | undefined> },
): Promise<VerifiedSession | null> {
  let token: string | null = null;
  if (request) {
    token = readCredential(request);
  } else {
    try {
      const jar = await cookies();
      token = jar.get(SESSION_COOKIE_NAME)?.value ?? null;
    } catch {
      token = null;
    }
  }
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const data = await getData();
  const session = await data.sessions.findByTokenHash(tokenHash);
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  if (session.user.disabled) return null;
  data.sessions.touch(session.id, new Date()).catch(() => null);
  return {
    uid: session.user.id,
    email: session.user.email,
    displayName: session.user.name,
    sessionId: session.id,
    authTime: Math.floor(session.createdAt.getTime() / 1000),
    isAdminClaim: isAdminUser({ id: session.user.id, email: session.user.email }),
    source: 'session-cookie',
  };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  const data = await getData();
  await data.sessions.revokeByTokenHash(tokenHash);
}

export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const data = await getData();
  return data.sessions.revokeAllForUser(userId);
}

export async function getCurrentUser(request?: Request): Promise<UserRecord | null> {
  const verified = await verifySession(request);
  if (!verified) return null;
  const data = await getData();
  return data.users.getById(verified.uid);
}

export async function verifyRequestToken(
  request?: Request | { headers: Record<string, string | string[] | undefined> },
): Promise<VerifiedSession | null> {
  return verifySession(request);
}

export function clearSessionCookie(): CookieInstruction {
  return {
    name: SESSION_COOKIE_NAME,
    value: '',
    options: { ...cookieOptions(0), maxAge: 0 },
  };
}

export async function resolveAuth(request?: Request): Promise<ResolvedAuth | null> {
  const verified = await verifySession(request);
  if (!verified) return null;
  const data = await getData();
  const user = await data.users.getById(verified.uid);
  if (!user) return null;
  return { user: { ...user, isAdmin: isAdminUser(user) }, token: verified };
}

export function readCookieFromHeaderUtil(header: string | null, name: string): string | null {
  return readCookieFromHeader(header ?? '', name);
}

function readCookieFromHeader(header: string, name: string): string | null {
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Buffer.from(hash).toString('hex');
}

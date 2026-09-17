import type { NextResponse } from 'next/server';
import { ACCESS_SESSION_TTL_MS } from '@mt/types';
import { getData } from '../data';
import { issueSessionForUser, verifyAccessSession } from '../access/access-service';
import { readCookie, setCookie, clearCookie } from './cookies';
import { ACCESS_COOKIE, SESSION_COOKIE } from './types';

export interface CookieInstruction {
  name: string;
  value: string;
  maxAgeSeconds: number;
}

/**
 * Prepares (without writing) an access cookie bound to a user id.
 *
 * It returns `null` when the browser has not unlocked via the typing game, or
 * when its access session predates the current secret-code epoch — logging in
 * must never bypass the access flow.
 */
export async function accessBindingCookie(
  request: Request,
  userId: string,
): Promise<CookieInstruction | null> {
  const existing = await verifyAccessSession(readCookie(request, ACCESS_COOKIE));
  if (!existing) return null;
  const data = await getData();
  const config = await data.config.getAccessConfig();
  if (existing.epoch !== config.epoch) return null;
  const issued = await issueSessionForUser(userId, config.epoch);
  return {
    name: ACCESS_COOKIE,
    value: issued.token,
    maxAgeSeconds: Math.floor(ACCESS_SESSION_TTL_MS / 1000),
  };
}

export function sessionCookie(value: string, ttlSeconds: number): CookieInstruction {
  return { name: SESSION_COOKIE, value, maxAgeSeconds: ttlSeconds };
}

export function applyCookies(response: NextResponse, cookies: CookieInstruction[]): NextResponse {
  for (const cookie of cookies) setCookie(response, cookie.name, cookie.value, cookie.maxAgeSeconds);
  return response;
}

/** Used by the privacy lock (triple tap / tab hidden) and by logout. */
export function revokeAccessSession(response: NextResponse): NextResponse {
  return clearCookie(response, ACCESS_COOKIE);
}

export function revokeSessionCookie(response: NextResponse): NextResponse {
  return clearCookie(response, SESSION_COOKIE);
}

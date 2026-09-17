import type { NextResponse } from 'next/server';
import { AppError } from '@mt/domain';
import { ACCESS_SESSION_TTL_MS, AUTH_SESSION_TTL_MS } from '@mt/types';
import { getData } from '../data';
import { logger } from '../logger';
import { issueSessionForUser, verifyAccessSession } from '../access/access-service';
import { readCookie, setCookie, clearCookie } from './cookies';
import { createFirebaseSessionCookie, isFreshCredential, verifyFirebaseIdToken, verifyFirebaseSessionCookie } from './firebase';
import { extractCredential } from './session';
import { ACCESS_COOKIE, SESSION_COOKIE, type VerifiedToken } from './types';

export interface CookieInstruction {
  name: string;
  value: string;
  maxAgeSeconds: number;
}

/** Session TTL as a cookie `Max-Age`, matching the Firebase session cookie. */
const SESSION_TTL_SECONDS = Math.floor(AUTH_SESSION_TTL_MS / 1000);

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

export function sessionCookie(value: string, ttlSeconds: number = SESSION_TTL_SECONDS): CookieInstruction {
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

export interface EstablishedSession {
  /** The verified Firebase identity behind the request. */
  verified: VerifiedToken;
  /**
   * The session cookie to set, or `null` when the caller already presented one
   * (nothing to mint) or when its ID token is too old to be upgraded. Bearer
   * requests keep working in that case; cookie-only requests (SSE) need a fresh
   * sign-in, which is what `requireFresh` is for.
   */
  cookie: CookieInstruction | null;
}

export interface EstablishSessionOptions {
  /** Message for the 401 when no credential verifies. Never reveals a cause. */
  failureMessage: string;
  /**
   * Refuse a credential that was not presented within
   * `FRESH_CREDENTIAL_MAX_AGE_MS`. Reauthentication requires it: the whole point
   * of that gate is proving the password is still known.
   */
  requireFresh?: boolean;
}

/**
 * Verifies the Firebase credential a request carries and exchanges a fresh ID
 * token for the httpOnly session cookie that every later request (including
 * `EventSource` streams, which cannot set an `Authorization` header) presents.
 *
 * This is the only place a session cookie is minted, so the freshness rule
 * Firebase's session-cookie guide requires is enforced once, for every route.
 */
export async function establishSession(
  request: Request,
  options: EstablishSessionOptions,
): Promise<EstablishedSession> {
  const credential = extractCredential(request);
  const verified = credential
    ? credential.source === 'id-token'
      ? await verifyFirebaseIdToken(credential.value)
      : await verifyFirebaseSessionCookie(credential.value)
    : null;

  if (!credential || !verified) {
    throw AppError.unauthenticated(options.failureMessage);
  }

  if (options.requireFresh && !isFreshCredential(verified)) {
    throw AppError.precondition('re-enter your password to continue');
  }

  // Already holding a session cookie: nothing to mint, and a session cookie can
  // never be exchanged for another one.
  if (credential.source === 'session-cookie') return { verified, cookie: null };

  if (!isFreshCredential(verified)) {
    logger.warn('auth.session_cookie_skipped_stale_credential', { uid: verified.uid });
    return { verified, cookie: null };
  }

  const value = await createFirebaseSessionCookie(credential.value, verified);
  return { verified, cookie: sessionCookie(value) };
}

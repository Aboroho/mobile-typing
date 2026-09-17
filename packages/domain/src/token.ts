import { base64UrlDecodeString, base64UrlEncodeString, timingSafeEqual } from '@mt/utils';

/**
 * Minimal HMAC-SHA256 signed token (`payload.signature`, both base64url).
 *
 * Used for the secret-code access session and its challenge token. It is
 * deliberately tiny and dependency free so the same verification can run in a
 * Next.js route handler, an edge runtime and the test suite. Firebase ID tokens
 * are *not* handled here — those are verified with the Admin SDK.
 */
export interface TokenClaims extends Record<string, unknown> {
  /** Audience, e.g. `access-session` or `access-challenge`. */
  aud: string;
  /** Expiry as epoch milliseconds. Added by `signToken`. */
  exp: number;
  /** Optional subject (user id) the token is bound to. */
  sub?: string;
}

/** What callers pass in; `exp` is computed from the TTL. */
export type TokenInput = Omit<TokenClaims, 'exp'>;

export interface SignedToken {
  token: string;
  expiresAt: string;
}

async function hmac(secret: string, value: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await globalThis.crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(value),
    );
    return base64UrlEncodeString(String.fromCharCode(...new Uint8Array(signature)));
  }
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export async function signToken(
  secret: string,
  claims: TokenInput,
  ttlMs: number,
  now: number = Date.now(),
): Promise<SignedToken> {
  if (!secret || secret.length < 16) {
    throw new Error('token signing secret must be at least 16 characters');
  }
  const exp = now + ttlMs;
  const payload = base64UrlEncodeString(JSON.stringify({ ...claims, exp }));
  const signature = await hmac(secret, payload);
  return { token: `${payload}.${signature}`, expiresAt: new Date(exp).toISOString() };
}

export interface VerifyTokenOptions {
  /** Rejects tokens issued for a different audience. */
  audience?: string;
  /** Rejects tokens bound to a different subject. */
  subject?: string;
  now?: number;
}

export async function verifyToken<T extends TokenInput>(
  secret: string,
  token: string | undefined | null,
  options?: VerifyTokenOptions,
): Promise<T | null> {
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(signature, expected)) return null;

  let claims: TokenClaims;
  try {
    claims = JSON.parse(base64UrlDecodeString(payload)) as TokenClaims;
  } catch {
    return null;
  }
  const now = options?.now ?? Date.now();
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (options?.audience && claims.aud !== options.audience) return null;
  if (options?.subject && claims.sub !== options.subject) return null;
  return claims as unknown as T;
}

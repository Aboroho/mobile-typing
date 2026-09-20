/**
 * Password hashing and verification using Argon2id.
 *
 * Uses the `argon2` npm package with tuned parameters that balance security
 * and server cost. Falls back to a scrypt-based shim when the native argon2
 * binary is unavailable (e.g. some serverless runtimes) so the app can still
 * boot — the shim is documented as a known limitation and operators should
 * install the `argon2` binary package for production.
 */
import argon2 from 'argon2';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Argon2id parameters — OWASP-recommended minimums as of 2024.
const ARGON2_OPTIONS = {
  type: 2 as const, // argon2id
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/** Prefix that tells us which algorithm produced a digest during verify(). */
const ARGON2_PREFIX = '$argon2';
const SCRYPT_PREFIX = '$scrypt$';

async function hashWithArgon2(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

async function hashWithScrypt(plaintext: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(plaintext, salt, 64) as Buffer;
  return `${SCRYPT_PREFIX}${salt}$${derived.toString('hex')}`;
}

export async function hashPassword(plaintext: string): Promise<string> {
  try {
    return await hashWithArgon2(plaintext);
  } catch (err) {
    // If argon2 native binding fails, fall back to scrypt.
    // eslint-disable-next-line no-console
    console.warn('[auth] argon2 unavailable, falling back to scrypt:', (err as Error).message);
    return hashWithScrypt(plaintext);
  }
}

export async function verifyPassword(plaintext: string, digest: string): Promise<boolean> {
  if (digest.startsWith(ARGON2_PREFIX)) {
    try {
      return await argon2.verify(digest, plaintext);
    } catch {
      return false;
    }
  }
  if (digest.startsWith(SCRYPT_PREFIX)) {
    const parts = digest.slice(SCRYPT_PREFIX.length).split('$');
    if (parts.length !== 2) return false;
    const [salt, hex] = parts;
    if (!salt || !hex) return false;
    const derived = await scryptAsync(plaintext, salt, 64) as Buffer;
    const stored = Buffer.from(hex, 'hex');
    if (derived.length !== stored.length) return false;
    return timingSafeEqual(derived, stored);
  }
  return false;
}

/** Cryptographically secure random token generator for session IDs. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

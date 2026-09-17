import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt password hashing for the development auth provider. Firebase owns
 * password storage in production; this exists only so the application can run
 * end to end without a Firebase project.
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(SALT_LENGTH).toString('hex');
  const derived = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return { hash: derived, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  const derived = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

import { SECRET_CODE_MAX_LENGTH } from '@mt/types';
import { sha256Hex, saltedDigest } from '@mt/utils';

/**
 * Rolling keystroke buffer + consecutive substring detection for the secret
 * code.
 *
 * Rules enforced here (and covered by unit tests):
 *  - buffer never grows past `maxLength` characters,
 *  - the code must appear as a *consecutive* substring (`axbyc` never matches `abc`),
 *  - matching is case sensitive,
 *  - a buffer shorter than the code can never match,
 *  - matching is idempotent: repeated keystrokes after a match do not re-fire
 *    (the caller receives `matched: true` exactly once per unlock),
 *  - only single printable characters are accepted, so paste/IME composition or
 *    modifier keys cannot poison the buffer.
 */
export interface KeystrokeBuffer {
  readonly maxLength: number;
  value: string;
  /** Set once the code matched; further pushes return `matched: false`. */
  matched: boolean;
  matchedAt: number | null;
}

export interface KeystrokeResult {
  matched: boolean;
  /** The secret code that matched (only on the transition to matched). */
  code: string | null;
  buffer: string;
}

export function createKeystrokeBuffer(maxLength: number = SECRET_CODE_MAX_LENGTH): KeystrokeBuffer {
  if (!Number.isFinite(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive number');
  }
  return { maxLength, value: '', matched: false, matchedAt: null };
}

export function resetKeystrokeBuffer(buffer: KeystrokeBuffer): KeystrokeBuffer {
  buffer.value = '';
  buffer.matched = false;
  buffer.matchedAt = null;
  return buffer;
}

/**
 * Accepts only what a virtual or physical keyboard can produce for a secret
 * code: single, printable, non-whitespace characters. Modifier keys, arrow keys
 * and multi character IME input are ignored.
 */
export function isAcceptableKeystroke(key: string): boolean {
  return key.length === 1 && !/\s/.test(key) && key.charCodeAt(0) >= 0x20;
}

export function pushKeystroke(
  buffer: KeystrokeBuffer,
  key: string,
  code: string,
  options?: { now?: () => number },
): KeystrokeResult {
  const now = options?.now ?? Date.now;
  if (buffer.matched || !isAcceptableKeystroke(key)) {
    return { matched: false, code: null, buffer: buffer.value };
  }

  buffer.value = (buffer.value + key).slice(-buffer.maxLength);

  if (matchesSecret(buffer.value, code)) {
    buffer.matched = true;
    buffer.matchedAt = now();
    // Never keep the matched secret in memory longer than needed.
    buffer.value = '';
    return { matched: true, code, buffer: buffer.value };
  }

  return { matched: false, code: null, buffer: buffer.value };
}

/**
 * Consecutive, case-sensitive substring match. Kept separate from the buffer so
 * the same predicate can be used for "did this already typed text contain the
 * code" checks (e.g. replaying a buffered word in the typing game).
 */
export function matchesSecret(buffer: string, code: string): boolean {
  if (code.length === 0) return false;
  if (buffer.length < code.length) return false;
  return buffer.includes(code);
}

/** Validates an administrator supplied code and returns its canonical form. */
export function normalizeSecretCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length < 3) throw new RangeError('secret code must be at least 3 characters');
  if (trimmed.length > SECRET_CODE_MAX_LENGTH) {
    throw new RangeError(`secret code must be at most ${SECRET_CODE_MAX_LENGTH} characters`);
  }
  if (/\s/.test(trimmed)) throw new RangeError('secret code must not contain whitespace');
  return trimmed;
}

export interface SecretCodeDigests {
  digest: string;
  saltedDigest: string;
}

/** The browser sends the plain digest; the server stores the salted one. */
export async function computeSecretCodeDigest(code: string): Promise<string> {
  return sha256Hex(code);
}

export async function digestSecretCodeForStorage(
  salt: string,
  code: string,
): Promise<SecretCodeDigests> {
  const [digest, stored] = await Promise.all([
    computeSecretCodeDigest(code),
    saltedDigest(salt, code),
  ]);
  return { digest, saltedDigest: stored };
}

/**
 * Primary server-side check used by the unlock endpoint: the browser submits the
 * SHA-256 digest of whatever the user typed, the server digests the configured
 * code and compares. The plaintext code therefore never crosses the wire twice.
 */
export async function matchesSubmittedDigest(
  configuredCode: string,
  submittedDigest: string,
): Promise<boolean> {
  if (!configuredCode || !submittedDigest) return false;
  return (await computeSecretCodeDigest(configuredCode)) === submittedDigest;
}

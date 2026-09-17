import { encodeUtf8, timingSafeEqual } from './base64';

/**
 * SHA-256 hex digest. Uses `node:crypto` on the server and WebCrypto in the
 * browser so the same digest can be produced on both sides (the secret-code
 * unlock flow only ever sends the digest, never the code).
 */
export async function sha256Hex(value: string): Promise<string> {
  // Delegates to the byte implementation so the browser (WebCrypto) and the
  // server (node:crypto) produce the identical hex string. The unlock flow
  // compares a browser-computed digest with a server-computed one, so the two
  // must agree exactly.
  return sha256HexBytes(encodeUtf8(value));
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Salted digest used for stored secret codes so they are not recoverable from a dump. */
export async function saltedDigest(salt: string, value: string): Promise<string> {
  return sha256Hex(`${salt}:${value}`);
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}

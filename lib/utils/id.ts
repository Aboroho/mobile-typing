import type { randomBytes as nodeRandomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(length: number): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }
  // Node without a global crypto (older runtimes / workers).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('node:crypto') as { randomBytes: typeof nodeRandomBytes };
  return new Uint8Array(nodeCrypto.randomBytes(length));
}

/** Collision-resistant, lexicographically sortable enough for Firestore ids. */
export function newId(prefix = ''): string {
  const bytes = randomBytes(16);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export function newUid(): string {
  return newId('u');
}

/** Deterministic uid for the development auth provider (stable across restarts). */
export function deterministicUid(email: string): string {
  const normalized = email.trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `dev_${hash.toString(36)}_${normalized.length.toString(36)}`;
}

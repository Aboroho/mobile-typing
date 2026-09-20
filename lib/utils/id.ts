import type { randomBytes as nodeRandomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(length: number): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }
  // Node without a global crypto (older runtimes / workers).
  const nodeCrypto = require('node:crypto') as { randomBytes: typeof nodeRandomBytes };
  return new Uint8Array(nodeCrypto.randomBytes(length));
}

/** Collision-resistant ids with an optional human-readable prefix. */
export function newId(prefix = ''): string {
  const bytes = randomBytes(16);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export function newUid(): string {
  return newId('u');
}

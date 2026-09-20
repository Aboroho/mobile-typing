import { encodeUtf8, timingSafeEqual } from './base64';

/**
 * SHA-256 hex digest. Uses WebCrypto wherever it exists and falls back to a
 * pure-JS implementation where it does not, so the same digest can be produced
 * on every side (the secret-code unlock flow only ever sends the digest, never
 * the code).
 *
 * The fallback matters for exactly one reason: `crypto.subtle` only exists in
 * *secure contexts* (HTTPS, localhost, …). A phone that opens the app over
 * plain HTTP — the usual way a mobile device reaches a dev server on the LAN
 * or a VPS without TLS — has no WebCrypto at all. Before the fallback existed,
 * typing the secret code on such a device threw from this function and the
 * unlock silently did nothing.
 */
export async function sha256Hex(value: string): Promise<string> {
  return sha256HexBytes(encodeUtf8(value));
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
      return toHex(new Uint8Array(digest));
    } catch {
      // Fall through to the pure implementation below.
    }
  }
  // Never attempt `node:crypto` in a browser bundle: it cannot resolve there
  // and the failure would surface as a broken unlock instead of a digest.
  if (isNodeRuntime()) {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
  }
  return toHex(sha256Pure(bytes));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

/**
 * Pure-JS SHA-256 (FIPS 180-4), used only where WebCrypto is unavailable
 * (non-secure browser contexts). Kept dependency-free and byte-oriented so it
 * is trivially testable against `node:crypto`.
 */
export function sha256Pure(input: Uint8Array): Uint8Array {
  // First round constants of FIPS 180-4 (fractional parts of the cube roots
  // of the first 64 primes).
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  // Copy the input so a caller-owned view (with an arbitrary byteOffset) can
  // never be corrupted by the padding step.
  const bytes = new Uint8Array(input.length);
  bytes.set(input);

  const bitLength = bytes.length * 8;
  // Message + 0x80 + zero padding + 8-byte length, rounded to a 64-byte block.
  const paddedLength = ((bytes.length + 8) >> 6 << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 64-bit big-endian bit length. Inputs here are far below 2^32 bits, but
  // write both halves correctly anyway.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      // Indices are provably in range; the `?? 0` only satisfies strict
      // index-access checking.
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function rotr(value: number, by: number): number {
  return (value >>> by) | (value << (32 - by));
}

/** Salted digest used for stored secret codes so they are not recoverable from a dump. */
export async function saltedDigest(salt: string, value: string): Promise<string> {
  return sha256Hex(`${salt}:${value}`);
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex, sha256Pure } from '@/lib/utils/hash';
import { encodeUtf8 } from '@/lib/utils';

function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pureHex(bytes: Uint8Array): string {
  return Buffer.from(sha256Pure(bytes)).toString('hex');
}

describe('sha256Pure — fallback for browsers without WebCrypto', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    // The two canonical vectors from the standard.
    expect(pureHex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(pureHex(encodeUtf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node:crypto for the secret code itself', () => {
    const code = 'opensesame';
    expect(pureHex(encodeUtf8(code))).toBe(nodeSha256Hex(encodeUtf8(code)));
  });

  it('matches node:crypto around the 64-byte block boundaries', () => {
    // Padding differs for lengths 55/56/63/64/65 — cover the edges exactly.
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const bytes = randomBytes(length);
      expect(pureHex(new Uint8Array(bytes))).toBe(nodeSha256Hex(new Uint8Array(bytes)));
    }
  });

  it('matches node:crypto on random payloads', () => {
    for (let i = 0; i < 25; i += 1) {
      const bytes = new Uint8Array(randomBytes(Math.floor(Math.random() * 2048)));
      expect(pureHex(bytes)).toBe(nodeSha256Hex(bytes));
    }
  });

  it('handles views into a larger buffer without corrupting them', () => {
    const backing = randomBytes(64);
    const view = new Uint8Array(backing.buffer, 10, 20);
    const before = Buffer.from(view).toString('hex');
    expect(pureHex(view)).toBe(nodeSha256Hex(view));
    expect(Buffer.from(view).toString('hex')).toBe(before);
  });
});

describe('sha256Hex', () => {
  it('produces the digest the unlock flow compares against', async () => {
    // The unlock endpoint compares this browser-side digest with the server's
    // own computation; the two spellings must agree character for character.
    await expect(sha256Hex('opensesame')).resolves.toBe(
      createHash('sha256').update('opensesame').digest('hex'),
    );
  });

  it('still digests when WebCrypto is unavailable (plain-HTTP mobile browser)', async () => {
    // A phone that reaches the app over plain HTTP is *not* a secure context:
    // `crypto.subtle` does not exist there. Typing the secret code used to die
    // right here, so the unlock silently did nothing on mobile.
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('process', { versions: {} });
    try {
      await expect(sha256Hex('opensesame')).resolves.toBe(
        createHash('sha256').update('opensesame').digest('hex'),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

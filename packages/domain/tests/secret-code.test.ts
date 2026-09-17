import { describe, expect, it } from 'vitest';
import { SECRET_CODE_MAX_LENGTH } from '@mt/types';
import {
  computeSecretCodeDigest,
  createKeystrokeBuffer,
  digestSecretCodeForStorage,
  isAcceptableKeystroke,
  matchesSecret,
  matchesSubmittedDigest,
  normalizeSecretCode,
  pushKeystroke,
  resetKeystrokeBuffer,
} from '../src/secret-code';

const CODE = 'opensesame';

function type(buffer: ReturnType<typeof createKeystrokeBuffer>, text: string, code = CODE) {
  let last: ReturnType<typeof pushKeystroke> | null = null;
  for (const key of text) last = pushKeystroke(buffer, key, code);
  return last;
}

describe('matchesSecret — consecutive, case-sensitive substring match', () => {
  it('matches when the code appears inside a longer stream', () => {
    expect(matchesSecret('typinopensesameg', CODE)).toBe(true);
    expect(matchesSecret(CODE, CODE)).toBe(true);
  });

  it('does not match non-consecutive characters', () => {
    expect(matchesSecret('o p e n s e s a m e', CODE)).toBe(false);
    expect(matchesSecret('opensXesame', CODE)).toBe(false);
  });

  it('is case sensitive', () => {
    expect(matchesSecret('OpenSesame', CODE)).toBe(false);
    expect(matchesSecret('OPENSESAME', CODE)).toBe(false);
  });

  it('needs a buffer at least as long as the code', () => {
    expect(matchesSecret('opensesam', CODE)).toBe(false);
    expect(matchesSecret('', CODE)).toBe(false);
    expect(matchesSecret('anything', '')).toBe(false);
  });
});

describe('pushKeystroke — rolling buffer', () => {
  it('fires once when the code completes inside ordinary typing', () => {
    const buffer = createKeystrokeBuffer();
    type(buffer, 'the quick brown fox ');
    const result = pushKeystroke(buffer, 'e', CODE); // ...opensesam -> opensesame
    type(buffer, 'opensesam');
    expect(result?.matched).toBe(false);
    const final = pushKeystroke(buffer, 'e', CODE);
    expect(final.matched).toBe(true);
    expect(final.code).toBe(CODE);
  });

  it('caps the buffer at the configured maximum', () => {
    const buffer = createKeystrokeBuffer(5);
    for (const key of 'abcdefgh') pushKeystroke(buffer, key, CODE);
    expect(buffer.value).toBe('defgh');
  });

  it('never grows past 15 characters, so a longer code can never match', () => {
    const buffer = createKeystrokeBuffer(SECRET_CODE_MAX_LENGTH);
    const longCode = 'a'.repeat(SECRET_CODE_MAX_LENGTH + 1);
    for (let i = 0; i < longCode.length; i += 1) {
      expect(pushKeystroke(buffer, 'a', longCode).matched).toBe(false);
    }
    expect(buffer.value.length).toBe(SECRET_CODE_MAX_LENGTH);
  });

  it('is case sensitive in practice', () => {
    const buffer = createKeystrokeBuffer();
    expect(type(buffer, 'OpenSesame')?.matched).toBe(false);
    expect(resetKeystrokeBuffer(buffer).value).toBe('');
    expect(type(buffer, 'opensesame')?.matched).toBe(true);
  });

  it('fires only once per buffer (a match cannot be replayed)', () => {
    const buffer = createKeystrokeBuffer();
    expect(type(buffer, CODE)?.matched).toBe(true);
    expect(buffer.value).toBe('');
    expect(pushKeystroke(buffer, 'e', CODE).matched).toBe(false);
  });

  it('clears the secret from the buffer after a match', () => {
    const buffer = createKeystrokeBuffer();
    const result = pushKeystroke(buffer, 'e', CODE);
    void result;
    type(buffer, 'opensesam');
    pushKeystroke(buffer, 'e', CODE);
    expect(buffer.value).not.toContain(CODE);
  });
});

describe('isAcceptableKeystroke', () => {
  it('accepts printable single characters', () => {
    for (const key of ['a', 'Z', '7', '!', '-', '.', '#']) expect(isAcceptableKeystroke(key)).toBe(true);
  });

  it('ignores modifiers, navigation keys, whitespace and IME composition', () => {
    for (const key of ['Shift', 'Enter', ' ', '\t', 'ab', 'Unidentified', '']) {
      expect(isAcceptableKeystroke(key)).toBe(false);
    }
  });
});

describe('normalizeSecretCode', () => {
  it('trims and accepts a code within the length bounds', () => {
    expect(normalizeSecretCode('  opensesame  ')).toBe('opensesame');
  });

  it('rejects whitespace inside the code, short codes and codes over the limit', () => {
    expect(() => normalizeSecretCode('open sesame')).toThrow(RangeError);
    expect(() => normalizeSecretCode('ab')).toThrow(RangeError);
    expect(() => normalizeSecretCode('a'.repeat(SECRET_CODE_MAX_LENGTH + 1))).toThrow(RangeError);
  });
});

describe('digest round trip', () => {
  it('accepts the digest the browser computes and rejects a different one', async () => {
    const stored = await digestSecretCodeForStorage('unit-test-salt', CODE);
    const submitted = await computeSecretCodeDigest(CODE);
    expect(await matchesSubmittedDigest(CODE, submitted)).toBe(true);
    expect(await matchesSubmittedDigest(CODE, await computeSecretCodeDigest('wrongcode'))).toBe(false);
    // The salted form is what is persisted, so a stolen store is not enough.
    expect(stored.saltedDigest).not.toBe(submitted);
  });

  it('never stores the plaintext or the unsalted digest', async () => {
    const stored = await digestSecretCodeForStorage('unit-test-salt', CODE);
    const plain = await computeSecretCodeDigest(CODE);
    expect(Object.values(stored).join(' ')).not.toContain(CODE);
    expect(stored.saltedDigest).not.toBe(plain);
  });
});

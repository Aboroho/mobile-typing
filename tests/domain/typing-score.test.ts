import { describe, expect, it } from 'vitest';
import {
  computeAccuracy,
  computeTypingResult,
  computeWordsPerMinute,
  diffWord,
  nextWordIndex,
  pickWords,
} from '@/lib/domain/typing-score';

describe('computeWordsPerMinute', () => {
  it('uses the 5-characters-per-word convention', () => {
    // 50 correct keystrokes = 10 words in one minute
    expect(computeWordsPerMinute(50, 60_000)).toBe(10);
  });

  it('scales with elapsed time', () => {
    expect(computeWordsPerMinute(25, 30_000)).toBe(10);
    expect(computeWordsPerMinute(25, 60_000)).toBe(5);
  });

  it('returns zero when no time elapsed', () => {
    expect(computeWordsPerMinute(50, 0)).toBe(0);
  });
});

describe('computeAccuracy', () => {
  it('is 1 for a perfect run and clamps to [0, 1]', () => {
    expect(computeAccuracy(10, 10)).toBe(1);
    expect(computeAccuracy(0, 10)).toBe(0);
    expect(computeAccuracy(15, 10)).toBe(1);
  });

  it('treats an empty run as perfect rather than NaN', () => {
    expect(computeAccuracy(0, 0)).toBe(1);
  });
});

describe('computeTypingResult', () => {
  it('counts correct and incorrect words and reports the elapsed time', () => {
    const result = computeTypingResult({
      language: 'en',
      durationSeconds: 60,
      attempts: [
        { word: 'alpha', typed: 'alpha', correct: true, durationMs: 1000 },
        { word: 'bravo', typed: 'brawo', correct: false, durationMs: 2000 },
      ],
      totalKeystrokes: 10,
      correctKeystrokes: 9,
      elapsedMs: 60_000,
    });
    expect(result.correctWords).toBe(1);
    expect(result.incorrectWords).toBe(1);
    expect(result.accuracy).toBeCloseTo(0.9, 5);
    // 9 correct keystrokes = 1.8 standard words typed in one minute.
    expect(result.wordsPerMinute).toBe(1.8);
    expect(result.elapsedMs).toBe(60_000);
  });
});

describe('diffWord', () => {
  it('marks each character correct or incorrect', () => {
    const { chars, extra } = diffWord('cat', 'cot');
    expect(chars.map((char) => char.state)).toEqual(['correct', 'incorrect', 'correct']);
    expect(extra).toBe(0);
  });

  it('reports characters typed beyond the word', () => {
    const { extra } = diffWord('cat', 'cats');
    expect(extra).toBe(1);
  });

  it('leaves untouched characters pending', () => {
    const { chars } = diffWord('cat', 'c');
    expect(chars.map((char) => char.state)).toEqual(['correct', 'pending', 'pending']);
  });
});

describe('pickWords', () => {
  it('returns the requested number of words without repeats while the pool lasts', () => {
    const picked = pickWords(['a', 'b', 'c', 'd'], 3, () => 0.5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
  });

  it('refills once the pool is exhausted so a long test never stalls', () => {
    const picked = pickWords(['a', 'b'], 5, () => 0.25);
    expect(picked).toHaveLength(5);
  });

  it('returns nothing for an empty word list', () => {
    expect(pickWords([], 5)).toEqual([]);
  });
});

it('wraps the word index', () => {
  expect(nextWordIndex(2, 3)).toBe(0);
  expect(nextWordIndex(0, 0)).toBe(0);
});

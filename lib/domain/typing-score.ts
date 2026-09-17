import type { TypingLanguage, TypingResult, TypingWordAttempt } from '@mt/types';

export interface ScoringInput {
  language: TypingLanguage;
  durationSeconds: number;
  attempts: TypingWordAttempt[];
  /** Keystrokes counted while the game ran, including backspaces? No — only inserts. */
  totalKeystrokes: number;
  correctKeystrokes: number;
  elapsedMs: number;
}

/**
 * Words-per-minute using the standard "5 characters = 1 word" convention, so
 * results are comparable with other typing tools. Computed from the characters
 * the user actually typed correctly, divided by the elapsed time.
 */
export function computeWordsPerMinute(correctKeystrokes: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  const minutes = elapsedMs / 60_000;
  const words = correctKeystrokes / 5;
  return Math.round((words / minutes) * 10) / 10;
}

export function computeAccuracy(correct: number, total: number): number {
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, Math.round((correct / total) * 1000) / 1000));
}

export function computeTypingResult(input: ScoringInput): TypingResult {
  const correctWords = input.attempts.filter((attempt) => attempt.correct).length;
  const incorrectWords = input.attempts.length - correctWords;
  const elapsedMs = Math.max(0, Math.round(input.elapsedMs));
  return {
    language: input.language,
    durationSeconds: input.durationSeconds,
    wordsPerMinute: computeWordsPerMinute(input.correctKeystrokes, elapsedMs),
    accuracy: computeAccuracy(input.correctKeystrokes, input.totalKeystrokes),
    correctWords,
    incorrectWords,
    totalKeystrokes: input.totalKeystrokes,
    correctKeystrokes: input.correctKeystrokes,
    elapsedMs,
  };
}

/**
 * Character level comparison used to highlight mistakes. Returns one entry per
 * character of the target word; extra characters typed beyond the word are
 * reported as `extra`.
 */
export interface CharacterState {
  char: string;
  typed: string | null;
  state: 'pending' | 'correct' | 'incorrect';
}

export function diffWord(target: string, typed: string): {
  chars: CharacterState[];
  extra: number;
} {
  const chars: CharacterState[] = [];
  for (let i = 0; i < target.length; i += 1) {
    const char = target[i] ?? '';
    const typedChar = typed[i];
    if (typedChar === undefined) {
      chars.push({ char, typed: null, state: 'pending' });
    } else {
      chars.push({ char, typed: typedChar, state: typedChar === char ? 'correct' : 'incorrect' });
    }
  }
  return { chars, extra: Math.max(0, typed.length - target.length) };
}

/**
 * Picks `count` distinct words from the list without repeating until the list is
 * exhausted. `random` is injectable so scoring/word selection is testable.
 */
export function pickWords(
  words: readonly string[],
  count: number,
  random: () => number = Math.random,
): string[] {
  if (words.length === 0) return [];
  const pool = [...words];
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    const [word] = pool.splice(index, 1);
    if (word !== undefined) picked.push(word);
  }
  // Pool exhausted: refill and keep going (a 120s test needs more than one pass).
  while (picked.length < count) {
    const index = Math.floor(random() * words.length);
    const word = words[index];
    if (word !== undefined) picked.push(word);
  }
  return picked;
}

export function nextWordIndex(currentIndex: number, total: number): number {
  if (total <= 0) return 0;
  return (currentIndex + 1) % total;
}

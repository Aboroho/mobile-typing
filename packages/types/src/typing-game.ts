import type { EntityTimestamps } from './common';

export const TypingLanguage = {
  English: 'en',
  Bengali: 'bn',
} as const;
export type TypingLanguage = (typeof TypingLanguage)[keyof typeof TypingLanguage];

export const TYPING_DURATIONS_SECONDS = [30, 60, 120] as const;
export type TypingDurationSeconds = (typeof TYPING_DURATIONS_SECONDS)[number];

export interface TypingWordAttempt {
  word: string;
  typed: string;
  correct: boolean;
  /** Milliseconds spent on this word, `null` while it is still being typed. */
  durationMs: number | null;
}

export interface TypingResult {
  language: TypingLanguage;
  durationSeconds: number;
  wordsPerMinute: number;
  accuracy: number;
  correctWords: number;
  incorrectWords: number;
  totalKeystrokes: number;
  correctKeystrokes: number;
  elapsedMs: number;
}

/** Persisted session — used for the admin dashboard and to keep the game real. */
export interface TypingSession extends EntityTimestamps {
  id: string;
  /** Null for visitors who never registered. */
  userId: string | null;
  result: TypingResult;
  attempts: TypingWordAttempt[];
}

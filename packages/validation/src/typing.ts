import { z } from 'zod';
import { TYPING_DURATIONS_SECONDS } from '@mt/types';

export const wordAttemptSchema = z.object({
  word: z.string().min(1).max(64),
  typed: z.string().max(128),
  correct: z.boolean(),
  durationMs: z.number().int().min(0).max(600_000).nullable(),
});

export const typingResultSchema = z.object({
  language: z.enum(['en', 'bn']),
  durationSeconds: z.number().refine((value) =>
    (TYPING_DURATIONS_SECONDS as readonly number[]).includes(value),
  ),
  wordsPerMinute: z.number().min(0).max(400),
  accuracy: z.number().min(0).max(1),
  correctWords: z.number().int().min(0).max(100_000),
  incorrectWords: z.number().int().min(0).max(100_000),
  totalKeystrokes: z.number().int().min(0).max(1_000_000),
  correctKeystrokes: z.number().int().min(0).max(1_000_000),
  elapsedMs: z.number().int().min(0).max(10 * 60 * 1000),
});

export const submitTypingSessionSchema = z.object({
  result: typingResultSchema,
  /** Only the last N attempts are stored; the full history never leaves the device. */
  attempts: z.array(wordAttemptSchema).max(200).default([]),
});

export type SubmitTypingSessionInput = z.input<typeof submitTypingSessionSchema>;

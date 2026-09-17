import type { TypingSession } from '@mt/types';
import { newId, nowIso } from '@mt/utils';
import type { SubmitTypingSessionInput } from '@mt/validation';
import { getData } from '../data';

/**
 * Persists a finished typing test. Anonymous visitors are recorded with a null
 * userId — the game is the public face of the product, so its statistics are
 * real. Only the last 200 word attempts are kept (validated by the schema).
 */
export async function submitTypingSession(input: {
  userId: string | null;
  payload: SubmitTypingSessionInput;
}): Promise<TypingSession> {
  const data = await getData();
  const now = nowIso();
  const session: TypingSession = {
    id: newId('ts'),
    userId: input.userId,
    result: input.payload.result,
    attempts: input.payload.attempts ?? [],
    createdAt: now,
    updatedAt: now,
  };
  return data.typingSessions.create(session);
}

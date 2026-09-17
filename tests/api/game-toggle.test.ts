/**
 * `NEXT_PUBLIC_ENABLE_TYPING_GAME=false` must let API requests through without
 * an access-session cookie, matching the client (which never shows the
 * typing-game/secret-code gate and therefore never produces one).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetStore } from '@/lib/data/memory';
import { resetEnvCache } from '@/lib/env';
import { requireAccess } from '@/lib/auth/guard';

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ENABLE_TYPING_GAME;
  resetEnvCache();
});

describe('requireAccess with the game disabled', () => {
  it('requires an access session by default (game enabled)', async () => {
    resetEnvCache();
    const request = new Request('http://localhost:3000/api/v1/messages');
    await expect(requireAccess(request)).rejects.toMatchObject({ code: 'ACCESS_REQUIRED' });
  });

  it('skips the access-session requirement when the game is disabled', async () => {
    process.env.NEXT_PUBLIC_ENABLE_TYPING_GAME = 'false';
    resetEnvCache();
    const request = new Request('http://localhost:3000/api/v1/messages');
    await expect(requireAccess(request)).resolves.toEqual({ epoch: 0, userId: null });
  });
});

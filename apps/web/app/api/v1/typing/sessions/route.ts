import { submitTypingSessionSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { resolveAuth } from '@/lib/auth/session';
import { submitTypingSession } from '@/lib/services/typing-service';
import { enforceRateLimit } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Records a finished typing test. Deliberately public (rate limited): the game
 * is the product's front door and works before anyone has an account.
 */
export const POST = routeHandler('/api/v1/typing/sessions', async (request) => {
  const input = parseWith(submitTypingSessionSchema, await readJson(request));
  await enforceRateLimit(request, 'typing:submit', { limit: 30, windowMs: 60_000 });
  const auth = await resolveAuth(request).catch(() => null);
  return jsonOk({ session: await submitTypingSession({ userId: auth?.user.id ?? null, payload: input }) }, 201);
});

import { passwordResetSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { getAuthProvider } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

/** Always answers 200 — the response must not reveal whether an account exists. */
export const POST = routeHandler('/api/v1/auth/password-reset', async (request) => {
  const input = parseWith(passwordResetSchema, await readJson(request));
  await enforceRateLimit(request, 'auth:reset', { limit: 3, windowMs: 30 * 60_000, subject: input.email });
  await getAuthProvider()
    .sendPasswordReset(input.email)
    .catch(() => false);
  return jsonOk({ sent: true });
});

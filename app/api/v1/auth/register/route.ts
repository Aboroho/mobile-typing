import { registerSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { register } from '@/lib/services/auth-service';
import { toSessionUser } from '@/lib/services/user-service';
import { accessBindingCookie, applyCookies } from '@/lib/auth/session-cookies';
import { enforceRateLimit } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Creates the application profile for a Firebase account the browser has just
 * signed up, and opens the session. The credential — not the body — decides who
 * is being registered.
 */
export const POST = routeHandler('/api/v1/auth/register', async (request) => {
  const input = parseWith(registerSchema, await readJson(request));
  await enforceRateLimit(request, 'auth:register', { limit: 5, windowMs: 10 * 60_000 });

  const outcome = await register({ name: input.name, email: input.email, request });
  // A brand new account only enters the chat if this browser already unlocked.
  const access = await accessBindingCookie(request, outcome.user.id);

  return applyCookies(
    jsonOk(
      {
        user: toSessionUser(outcome.user),
        token: outcome.token,
        cookieSession: outcome.cookieSession,
        accessGranted: Boolean(access),
      },
      201,
    ),
    [...(outcome.session ? [outcome.session] : []), ...(access ? [access] : [])],
  );
});

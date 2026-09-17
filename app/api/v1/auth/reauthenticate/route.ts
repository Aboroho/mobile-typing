import { reauthenticateSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { reauthenticate } from '@/lib/services/auth-service';
import { toSessionUser } from '@/lib/services/user-service';
import { accessBindingCookie, applyCookies, sessionCookie } from '@/lib/auth/session-cookies';
import { enforceRateLimit } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Password gate for an already signed-in user (the third access-flow branch).
 * On success the access session is bound to the user so the chat can open.
 */
export const POST = routeHandler('/api/v1/auth/reauthenticate', async (request) => {
  const input = parseWith(reauthenticateSchema, await readJson(request));
  await enforceRateLimit(request, 'auth:reauth', { limit: 6, windowMs: 10 * 60_000 });

  const outcome = await reauthenticate({ password: input.password, request });
  const access = await accessBindingCookie(request, outcome.user.id);

  return applyCookies(
    jsonOk({ user: toSessionUser(outcome.user), accessGranted: Boolean(access) }),
    [
      ...(outcome.token ? [sessionCookie(outcome.token, SESSION_TTL_SECONDS)] : []),
      ...(access ? [access] : []),
    ],
  );
});

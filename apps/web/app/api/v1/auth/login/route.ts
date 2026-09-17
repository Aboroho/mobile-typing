import { loginSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { login } from '@/lib/services/auth-service';
import { toSessionUser } from '@/lib/services/user-service';
import { accessBindingCookie, applyCookies, sessionCookie } from '@/lib/auth/session-cookies';
import { enforceRateLimit, clientIp } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export const POST = routeHandler('/api/v1/auth/login', async (request) => {
  const input = parseWith(loginSchema, await readJson(request));
  // Tight limit: this is the endpoint an attacker would hammer.
  await enforceRateLimit(request, 'auth:login', { limit: 8, windowMs: 10 * 60_000, subject: input.email });

  const outcome = await login({ email: input.email, password: input.password, request });
  const access = await accessBindingCookie(request, outcome.user.id);
  logger.info('auth.login', { uid: outcome.user.id, ip: clientIp(request) });

  return applyCookies(
    jsonOk({
      user: toSessionUser(outcome.user),
      token: outcome.token,
      cookieSession: outcome.cookieSession,
      accessGranted: Boolean(access),
    }),
    [
      ...(outcome.token ? [sessionCookie(outcome.token, SESSION_TTL_SECONDS)] : []),
      ...(access ? [access] : []),
    ],
  );
});

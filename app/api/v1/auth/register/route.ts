import { registerSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { register } from '@/lib/services/auth-service';
import { toSessionUser } from '@/lib/services/user-service';
import { accessBindingCookie, applyCookies, type CookieInstruction } from '@/lib/auth/session-cookies';
import { enforceRateLimit } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logger';
import type { CookieInstruction as SessionCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/auth/register`
 *
 * Contract (see docs/api.md → "Signup"):
 *
 * | outcome                                        | status | `data.created` |
 * | ---------------------------------------------- | ------ | -------------- |
 * | account created, session cookie set             | 201    | `true`         |
 * | email already registered, password correct      | 200    | `false`        |
 * | email already registered, password wrong        | 401    | —              |
 * | payload invalid / password too weak             | 422    | —              |
 * | too many attempts                               | 429    | —              |
 * | database or session failure                     | 500    | —              |
 *
 * Both 201 and 200 leave the browser with a valid `mt_session` cookie, so a
 * repeated submit (double click, browser retry, a client bug) is a success and
 * never produces the "cannot create account" message on an account that
 * exists.
 */
export const POST = routeHandler('/api/v1/auth/register', async (request) => {
  const input = parseWith(registerSchema, await readJson(request));
  await enforceRateLimit(request, 'auth:register', { limit: 5, windowMs: 10 * 60_000, subject: input.email });

  const outcome = await register({ name: input.name, email: input.email, password: input.password, request });

  // Binding the access session is a convenience for the UI, not part of
  // creating the account: if it fails the signup still succeeded and the
  // response must say so.
  let access: CookieInstruction | SessionCookie | null = null;
  try {
    access = await accessBindingCookie(request, outcome.user.id);
  } catch (error) {
    logger.warn('auth.register_access_binding_failed', { uid: outcome.user.id, error: String(error) });
  }

  logger.info('auth.register_completed', {
    uid: outcome.user.id,
    created: outcome.created,
    sessionIssued: Boolean(outcome.session),
    accessGranted: Boolean(access),
  });

  return applyCookies(
    jsonOk(
      {
        user: toSessionUser(outcome.user),
        token: outcome.token,
        cookieSession: outcome.cookieSession,
        accessGranted: Boolean(access),
        created: outcome.created,
      },
      outcome.created ? 201 : 200,
    ),
    [...(outcome.session ? [outcome.session] : []), ...(access ? [access] : [])],
  );
});

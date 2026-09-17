import { ACCESS_SESSION_TTL_MS } from '@mt/types';
import { unlockAccessSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { unlock } from '@/lib/access/access-service';
import { setCookie } from '@/lib/auth/cookies';
import { ACCESS_COOKIE } from '@/lib/auth/types';
import { resolveAuth } from '@/lib/auth/session';
import { toSessionUser } from '@/lib/services/user-service';
import { enforceRateLimit, clientIp } from '@/lib/security/rate-limit';
import { AppError } from '@mt/domain';

export const dynamic = 'force-dynamic';

/**
 * Exchanges a challenge token + SHA-256 digest of the typed code for an access
 * session cookie. The plaintext code never crosses the wire.
 */
export const POST = routeHandler('/api/v1/access/unlock', async (request) => {
  const input = parseWith(unlockAccessSchema, await readJson(request));
  await enforceRateLimit(request, 'access:unlock', { limit: 10, windowMs: 60_000 });

  const auth = await resolveAuth(request).catch(() => null);
  const outcome = await unlock({
    challengeToken: input.challengeToken,
    digest: input.digest,
    userId: auth?.user.id,
    ipAddress: clientIp(request),
  });
  if (!outcome.unlocked) {
    throw new AppError('PRECONDITION_FAILED', 'that was not the right sequence');
  }

  const response = jsonOk({
    unlocked: true,
    epoch: outcome.epoch,
    expiresAt: outcome.expiresAt,
    user: auth ? toSessionUser(auth.user) : null,
  });
  setCookie(response, ACCESS_COOKIE, outcome.token, Math.floor(ACCESS_SESSION_TTL_MS / 1000));
  return response;
});

import { routeHandler, jsonOk } from '@/lib/api/http';
import { getAccessStatus, verifyAccessSession } from '@/lib/access/access-service';
import { readCookie } from '@/lib/auth/cookies';
import { ACCESS_COOKIE } from '@/lib/auth/types';

export const dynamic = 'force-dynamic';

/**
 * Configuration plus whether *this browser* already holds a valid access
 * session. Used on load so a returning visitor is not sent back to the typing
 * game when the httpOnly cookie is still good.
 */
export const GET = routeHandler('/api/v1/access/status', async (request) => {
  const status = await getAccessStatus();
  const session = await verifyAccessSession(readCookie(request, ACCESS_COOKIE));
  // A session minted for an older epoch (the code was rotated) is worthless.
  const valid = session !== null && session.epoch === status.epoch;
  return jsonOk({
    status,
    unlocked: valid,
    session:
      valid && session
        ? { epoch: session.epoch, expiresAt: session.expiresAt, userId: session.userId }
        : null,
  });
});

import { routeHandler, jsonOk } from '@/lib/api/http';
import { logout } from '@/lib/services/auth-service';
import { revokeAccessSession, revokeSessionCookie } from '@/lib/auth/session-cookies';

export const dynamic = 'force-dynamic';

export const POST = routeHandler('/api/v1/auth/logout', async (request) => {
  await logout(request);
  return revokeSessionCookie(revokeAccessSession(jsonOk({ loggedOut: true })));
});

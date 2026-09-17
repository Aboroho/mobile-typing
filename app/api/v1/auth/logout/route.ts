import { routeHandler, jsonOk } from '@/lib/api/http';
import { logout } from '@/lib/services/auth-service';
import { revokeAccessSession, revokeSessionCookie } from '@/lib/auth/session-cookies';

export const dynamic = 'force-dynamic';

/**
 * Ends the session on both sides: Firebase credentials are revoked server side
 * (so a copied session cookie stops working immediately) and the cookies this
 * API set are cleared. The browser signs out of the Firebase SDK itself.
 */
export const POST = routeHandler('/api/v1/auth/logout', async (request) => {
  await logout(request);
  return revokeSessionCookie(revokeAccessSession(jsonOk({ loggedOut: true })));
});

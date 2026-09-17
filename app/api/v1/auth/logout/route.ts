import { routeHandler, jsonOk } from '@/lib/api/http';
import { revokeAccessSession, revokeSessionCookie } from '@/lib/auth/session-cookies';

export const dynamic = 'force-dynamic';

export const POST = routeHandler('/api/v1/auth/logout', async () =>
  revokeSessionCookie(revokeAccessSession(jsonOk({ loggedOut: true }))),
);

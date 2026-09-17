import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { iceServers } from '@/lib/services/call-service';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** TURN credentials are handed out only to authenticated, unlocked users. */
export const GET = routeHandler('/api/v1/calls/ice-servers', async (request) => {
  await requireAuthenticatedAccess(request);
  const servers = iceServers();
  return jsonOk({
    iceServers: servers,
    hasTurn: Boolean(env().TURN_SERVER_URL && env().TURN_SERVER_USERNAME && env().TURN_SERVER_CREDENTIAL),
  });
});

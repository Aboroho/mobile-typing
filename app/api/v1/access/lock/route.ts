import { routeHandler, jsonOk } from '@/lib/api/http';
import { revokeAccessSession } from '@/lib/auth/session-cookies';

export const dynamic = 'force-dynamic';

/**
 * Ends the access session. Called by the privacy lock (triple tap, tab hidden)
 * so a backgrounded browser cannot resume straight into the chat.
 */
export const POST = routeHandler('/api/v1/access/lock', async () =>
  revokeAccessSession(jsonOk({ locked: true })),
);

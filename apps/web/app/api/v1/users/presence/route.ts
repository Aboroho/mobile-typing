import { z } from 'zod';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { setPresence } from '@/lib/services/user-service';

export const dynamic = 'force-dynamic';

const schema = z.object({ userId: z.string().optional(), state: z.enum(['online', 'offline']) });

export const POST = routeHandler('/api/v1/users/presence', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const input = parseWith(schema, await readJson(request));
  // The user id in the body is advisory; the token decides whose presence moves.
  const presence = await setPresence(user.id, input.state);
  return jsonOk({ userId: user.id, presence });
});

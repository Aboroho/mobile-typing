import { searchQuerySchema } from '@mt/validation';
import { routeHandler, jsonOk, readQuery, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { searchUsers } from '@/lib/services/user-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/users/search', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const query = parseWith(searchQuerySchema, readQuery(request));
  const items = await searchUsers({ actorId: user.id, q: query.q, limit: query.limit });
  return jsonOk({ items });
});

import { listCallsQuerySchema } from '@mt/validation';
import { routeHandler, jsonOk, readQuery, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { listCalls } from '@/lib/services/admin-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/admin/calls', async (request) => {
  await requireAdminAccess(request);
  const query = parseWith(listCallsQuerySchema, readQuery(request));
  return jsonOk(await listCalls({ limit: query.limit, cursor: query.cursor }));
});

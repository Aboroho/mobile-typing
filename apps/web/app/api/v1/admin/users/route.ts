import { adminListUsersSchema } from '@mt/validation';
import { routeHandler, jsonOk, readQuery, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { listUsers } from '@/lib/services/admin-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/admin/users', async (request) => {
  await requireAdminAccess(request);
  const query = parseWith(adminListUsersSchema, readQuery(request));
  return jsonOk(
    await listUsers({ q: query.q, status: query.status, limit: query.limit, cursor: query.cursor }),
  );
});

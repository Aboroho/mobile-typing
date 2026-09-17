import { adminListMediaSchema } from '@mt/validation';
import { routeHandler, jsonOk, readQuery, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { listMedia } from '@/lib/services/admin-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/admin/media', async (request) => {
  await requireAdminAccess(request);
  const query = parseWith(adminListMediaSchema, readQuery(request));
  return jsonOk(
    await listMedia({
      kind: query.kind,
      includeDeleted: query.includeDeleted,
      viewOnceOnly: query.viewOnceOnly,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
});

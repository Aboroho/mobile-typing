import { adminAuditQuerySchema } from '@mt/validation';
import { routeHandler, jsonOk, readQuery, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { listAuditLogs } from '@/lib/services/admin-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/admin/audit-logs', async (request) => {
  await requireAdminAccess(request);
  const query = parseWith(adminAuditQuerySchema, readQuery(request));
  return jsonOk(
    await listAuditLogs({
      limit: query.limit,
      cursor: query.cursor,
      action: query.action,
      actorUid: query.actorUid,
    }),
  );
});

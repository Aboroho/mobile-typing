import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { getDashboard } from '@/lib/services/admin-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/admin/dashboard', async (request) => {
  await requireAdminAccess(request);
  return jsonOk({ dashboard: await getDashboard() });
});

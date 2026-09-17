import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { getUserDetail } from '@/lib/services/admin-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler<{ userId: string }>(
  '/api/v1/admin/users/[userId]',
  async (request, { params }) => {
    await requireAdminAccess(request);
    return jsonOk(await getUserDetail(params.userId));
  },
);

import { adminUpdateUserStatusSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { updateUserStatus } from '@/lib/services/admin-service';
import { clientIp } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ userId: string }>(
  '/api/v1/admin/users/[userId]/status',
  async (request, { params }) => {
    const { user } = await requireAdminAccess(request);
    const input = parseWith(adminUpdateUserStatusSchema, await readJson(request));
    return jsonOk({
      user: await updateUserStatus({
        admin: { id: user.id, email: user.email, ipAddress: clientIp(request) },
        userId: params.userId,
        status: input.status,
        reason: input.reason,
      }),
    });
  },
);

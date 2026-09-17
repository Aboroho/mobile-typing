import { adminListMessagesSchema } from '@mt/validation';
import { routeHandler, jsonOk, readQuery, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { listConversationMessages } from '@/lib/services/admin-service';
import { clientIp } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

/** Includes soft deleted messages; every read is written to the audit log. */
export const GET = routeHandler<{ conversationId: string }>(
  '/api/v1/admin/conversations/[conversationId]/messages',
  async (request, { params }) => {
    const { user } = await requireAdminAccess(request);
    const query = parseWith(adminListMessagesSchema, readQuery(request));
    return jsonOk(
      await listConversationMessages({
        admin: { id: user.id, email: user.email, ipAddress: clientIp(request) },
        conversationId: params.conversationId,
        limit: query.limit,
        cursor: query.cursor,
        q: query.q,
      }),
    );
  },
);

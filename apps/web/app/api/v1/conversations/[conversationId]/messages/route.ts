import { listMessagesQuerySchema } from '@mt/validation';
import { routeHandler, jsonOk, readQuery, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { listMessages } from '@/lib/services/message-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]/messages',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const query = parseWith(listMessagesQuerySchema, readQuery(request));
    return jsonOk(
      await listMessages({
        viewerId: user.id,
        conversationId: params.conversationId,
        limit: query.limit,
        before: query.before,
        after: query.after,
        q: query.q,
      }),
    );
  },
);

import { blockUserSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { setBlocked } from '@/lib/services/conversation-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]/block',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(blockUserSchema, await readJson(request));
    await setBlocked({
      userId: user.id,
      conversationId: params.conversationId,
      blockedUserId: input.blockedUserId,
      blocked: input.blocked,
    });
    return jsonOk({ blocked: input.blocked });
  },
);

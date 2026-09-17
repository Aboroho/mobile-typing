import { hideConversationSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { setConversationHidden } from '@/lib/services/conversation-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]/visibility',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(hideConversationSchema, await readJson(request));
    await setConversationHidden({ userId: user.id, conversationId: params.conversationId, hidden: input.hidden });
    return jsonOk({ hidden: input.hidden });
  },
);

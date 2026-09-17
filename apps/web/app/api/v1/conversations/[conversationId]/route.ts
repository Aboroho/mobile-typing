import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { getConversationView, requireParticipant } from '@/lib/services/conversation-service';
import { getActiveCallForUser, iceServers } from '@/lib/services/call-service';
import { toCallView } from '@/lib/services/call-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const conversation = await requireParticipant(params.conversationId, user.id);
    const active = await getActiveCallForUser(user.id);
    return jsonOk({
      conversation: await getConversationView(conversation, user.id),
      iceServers: iceServers(),
      activeCall:
        active && active.conversationId === params.conversationId ? toCallView(active) : null,
    });
  },
);

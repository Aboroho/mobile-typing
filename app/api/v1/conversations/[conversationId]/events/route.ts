import { routeHandler } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { requireParticipant } from '@/lib/services/conversation-service';
import { createEventStream } from '@/lib/realtime/sse';
import { topics } from '@/lib/realtime/bus';
import type { RealtimeEvent } from '@/lib/realtime/bus';

export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events stream for one conversation: new/updated/deleted messages,
 * delivery + read receipts, typing indicators and call state.
 */
export const GET = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]/events',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    await requireParticipant(params.conversationId, user.id);

    const stream = createEventStream({
      topics: [
        topics.messages(params.conversationId),
        topics.typing(params.conversationId),
        topics.conversation(params.conversationId),
      ],
      // Only forward events addressed to this participant.
      filter: (event: RealtimeEvent) => {
        const payload = event.payload as { forUserId?: string; otherUserId?: string };
        if (payload.forUserId) return payload.forUserId === user.id;
        if (payload.otherUserId) return payload.otherUserId === user.id;
        return true;
      },
      signal: request.signal,
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
);

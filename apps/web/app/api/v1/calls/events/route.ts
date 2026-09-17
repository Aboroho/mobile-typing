import { routeHandler } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { createEventStream } from '@/lib/realtime/sse';
import { topics } from '@/lib/realtime/bus';

export const dynamic = 'force-dynamic';

/** Incoming-call notifications and call signalling for the current user. */
export const GET = routeHandler('/api/v1/calls/events', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const stream = createEventStream({ topics: [topics.userCalls(user.id)] });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

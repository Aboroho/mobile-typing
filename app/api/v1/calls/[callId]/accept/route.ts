import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { acceptCall } from '@/lib/services/call-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ callId: string }>(
  '/api/v1/calls/[callId]/accept',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    return jsonOk({ call: await acceptCall({ actor: user, callId: params.callId }) });
  },
);

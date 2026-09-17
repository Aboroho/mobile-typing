import { rejectCallSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { rejectCall } from '@/lib/services/call-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ callId: string }>(
  '/api/v1/calls/[callId]/reject',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(rejectCallSchema, (await readJson(request)) as object);
    return jsonOk({ call: await rejectCall({ actor: user, callId: params.callId, reason: input.reason }) });
  },
);

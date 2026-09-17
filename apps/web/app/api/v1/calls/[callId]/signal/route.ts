import { signalCallSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { signalCall } from '@/lib/services/call-service';

export const dynamic = 'force-dynamic';

/** WebRTC signalling relay (SDP offer/answer and ICE candidates). */
export const POST = routeHandler<{ callId: string }>(
  '/api/v1/calls/[callId]/signal',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(signalCallSchema, await readJson(request));
    await signalCall({
      actor: user,
      callId: params.callId,
      kind: input.kind,
      payload: input.payload,
    });
    return jsonOk({ accepted: true });
  },
);

import { markDeliveredSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { markDelivered } from '@/lib/services/receipt-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]/messages/delivery',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(markDeliveredSchema, await readJson(request));
    const result = await markDelivered({
      actor: user,
      conversationId: params.conversationId,
      messageIds: input.messageIds,
      state: input.state,
    });
    return jsonOk({ updated: result.updated, messageIds: result.messageIds });
  },
);

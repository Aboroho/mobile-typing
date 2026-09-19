import { markConversationReadSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { markConversationRead } from '@/lib/services/receipt-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]/read',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(markConversationReadSchema, await readJson(request));
    const result = await markConversationRead({
      actor: user,
      conversationId: params.conversationId,
      lastReadMessageAt: input.lastReadMessageAt,
    });
    return jsonOk({ ok: true as const, updated: result.updated, messageIds: result.messageIds });
  },
);

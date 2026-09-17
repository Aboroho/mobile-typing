import { typingIndicatorSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { setTyping } from '@/lib/services/conversation-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler<{ conversationId: string }>(
  '/api/v1/conversations/[conversationId]/typing',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(typingIndicatorSchema, await readJson(request));
    await setTyping({ userId: user.id, conversationId: params.conversationId, isTyping: input.isTyping });
    return jsonOk({ ok: true as const });
  },
);

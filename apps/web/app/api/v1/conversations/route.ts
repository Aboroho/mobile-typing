import { createConversationSchema, listConversationsQuerySchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, readQuery, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { ensureConversation, getConversationView, listConversations } from '@/lib/services/conversation-service';
import { expireStaleCalls } from '@/lib/services/call-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/conversations', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const query = parseWith(listConversationsQuerySchema, readQuery(request));
  await expireStaleCalls(user.id);
  return jsonOk(await listConversations({
    userId: user.id,
    limit: query.limit,
    cursor: query.cursor,
    includeHidden: query.includeHidden,
  }));
});

export const POST = routeHandler('/api/v1/conversations', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const input = parseWith(createConversationSchema, await readJson(request));
  const conversation = await ensureConversation({ actorId: user.id, otherId: input.participantId });
  return jsonOk({ conversation: await getConversationView(conversation, user.id) }, 201);
});

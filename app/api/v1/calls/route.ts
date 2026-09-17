import { createCallSchema, listCallsQuerySchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, readQuery, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { createCall, expireStaleCalls, listCalls } from '@/lib/services/call-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/calls', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const query = parseWith(listCallsQuerySchema, readQuery(request));
  await expireStaleCalls(user.id);
  return jsonOk(
    await listCalls({
      userId: user.id,
      conversationId: query.conversationId,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
});

export const POST = routeHandler('/api/v1/calls', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const input = parseWith(createCallSchema, await readJson(request));
  return jsonOk(await createCall({ actor: user, conversationId: input.conversationId }), 201);
});

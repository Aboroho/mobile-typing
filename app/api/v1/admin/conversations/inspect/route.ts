import { adminInspectConversationSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { inspectConversation } from '@/lib/services/admin-service';
import { clientIp } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

export const POST = routeHandler('/api/v1/admin/conversations/inspect', async (request) => {
  const { user } = await requireAdminAccess(request);
  const input = parseWith(adminInspectConversationSchema, await readJson(request));
  return jsonOk(
    await inspectConversation({
      admin: { id: user.id, email: user.email, ipAddress: clientIp(request) },
      participantA: input.participantA,
      participantB: input.participantB,
    }),
  );
});

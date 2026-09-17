import { sendMediaMessageSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { sendMediaMessage } from '@/lib/services/media-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler('/api/v1/media/messages', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const input = parseWith(sendMediaMessageSchema, await readJson(request));
  return jsonOk(
    await sendMediaMessage({
      actor: user,
      conversationId: input.conversationId,
      mediaId: input.mediaId,
      type: input.type,
      caption: input.caption,
      clientMessageId: input.clientMessageId,
      viewOnce: input.viewOnce,
    }),
    201,
  );
});

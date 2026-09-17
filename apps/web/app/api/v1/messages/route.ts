import { sendMessageSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { sendMessage } from '@/lib/services/message-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler('/api/v1/messages', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const input = parseWith(sendMessageSchema, await readJson(request));
  return jsonOk(
    await sendMessage({
      actor: user,
      conversationId: input.conversationId,
      type: input.type,
      text: input.text,
      mediaId: input.mediaId,
      viewOnce: input.viewOnce,
      clientMessageId: input.clientMessageId,
      replyToMessageId: input.replyTo?.messageId,
    }),
    201,
  );
});

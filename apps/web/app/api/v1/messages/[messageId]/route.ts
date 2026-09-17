import { deleteMessageSchema, editMessageSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { deleteMessage, editMessage, getVisibleMessage } from '@/lib/services/message-service';

export const dynamic = 'force-dynamic';

/** Re-reads a single message (used to recover from a failed optimistic update). */
export const GET = routeHandler<{ messageId: string }>(
  '/api/v1/messages/[messageId]',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    return jsonOk({ message: await getVisibleMessage({ viewerId: user.id, messageId: params.messageId }) });
  },
);

/** Edits are limited to the author inside the 2 minute server-side window. */
export const PATCH = routeHandler<{ messageId: string }>(
  '/api/v1/messages/[messageId]',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(editMessageSchema, await readJson(request));
    return jsonOk(
      await editMessage({ actor: user, messageId: params.messageId, text: input.text }),
    );
  },
);

/** Soft delete: the row is kept for administrators, hidden from users. */
export const DELETE = routeHandler<{ messageId: string }>(
  '/api/v1/messages/[messageId]',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(deleteMessageSchema, (await readJson(request)) as object);
    await deleteMessage({
      actor: user,
      messageId: params.messageId,
      scope: input.scope,
      reason: input.reason,
    });
    return jsonOk({ deleted: true as const });
  },
);

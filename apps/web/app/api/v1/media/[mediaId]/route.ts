import { deleteMediaSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { getMediaRecord, softDeleteMedia } from '@/lib/services/media-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler<{ mediaId: string }>(
  '/api/v1/media/[mediaId]',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    return jsonOk({ media: await getMediaRecord({ viewer: user, mediaId: params.mediaId, isAdminRequest: false }) });
  },
);

export const DELETE = routeHandler<{ mediaId: string }>(
  '/api/v1/media/[mediaId]',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const input = parseWith(deleteMediaSchema, (await readJson(request)) as object);
    await softDeleteMedia({ actor: user, mediaId: params.mediaId, reason: input.reason });
    return jsonOk({ deleted: true as const });
  },
);

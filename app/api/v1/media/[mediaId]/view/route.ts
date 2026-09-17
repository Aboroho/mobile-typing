import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { openViewOnce } from '@/lib/services/media-service';

export const dynamic = 'force-dynamic';

/**
 * Atomically claims a one-time-view image. A second call fails with
 * PRECONDITION_FAILED, which is what makes "view once" hold even under
 * simultaneous taps.
 */
export const POST = routeHandler<{ mediaId: string }>(
  '/api/v1/media/[mediaId]/view',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    return jsonOk(await openViewOnce({ actor: user, mediaId: params.mediaId }));
  },
);

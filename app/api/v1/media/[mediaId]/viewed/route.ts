import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { markMediaViewed } from '@/lib/services/media-service';

export const dynamic = 'force-dynamic';

/** Confirmation that the recipient finished viewing; informs the sender. */
export const POST = routeHandler<{ mediaId: string }>(
  '/api/v1/media/[mediaId]/viewed',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    await markMediaViewed({ actor: user, mediaId: params.mediaId });
    return jsonOk({ viewed: true });
  },
);

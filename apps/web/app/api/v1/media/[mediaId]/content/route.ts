import { routeHandler } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { fetchMediaContent } from '@/lib/services/media-service';

export const dynamic = 'force-dynamic';

/**
 * Authorised media retrieval. There is never a public URL for user media: every
 * byte goes through this route, which enforces participant + deletion + view-once
 * rules and disables caching.
 */
export const GET = routeHandler<{ mediaId: string }>(
  '/api/v1/media/[mediaId]/content',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const content = await fetchMediaContent({
      viewer: user,
      mediaId: params.mediaId,
      isAdminRequest: false,
    });

    if (content.redirectUrl) {
      return new Response(null, { status: 302, headers: { Location: content.redirectUrl } });
    }
    return new Response(Buffer.from(content.bytes ?? new Uint8Array()), {
      headers: {
        'Content-Type': content.contentType,
        'Cache-Control': content.cacheControl,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    });
  },
);

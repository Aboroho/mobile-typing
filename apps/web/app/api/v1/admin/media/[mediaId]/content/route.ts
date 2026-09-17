import { routeHandler } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { fetchMediaContent } from '@/lib/services/media-service';
import { clientIp } from '@/lib/security/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Administrative media access, including soft deleted and already viewed
 * one-time media. Every retrieval writes an audit entry.
 */
export const GET = routeHandler<{ mediaId: string }>(
  '/api/v1/admin/media/[mediaId]/content',
  async (request, { params }) => {
    const { user } = await requireAdminAccess(request);
    const content = await fetchMediaContent({
      viewer: user,
      mediaId: params.mediaId,
      isAdminRequest: true,
      ipAddress: clientIp(request),
    });
    if (content.redirectUrl) {
      return new Response(null, { status: 302, headers: { Location: content.redirectUrl } });
    }
    return new Response(Buffer.from(content.bytes ?? new Uint8Array()), {
      headers: {
        'Content-Type': content.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
);

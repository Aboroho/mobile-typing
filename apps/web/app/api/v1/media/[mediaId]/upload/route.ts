import { AppError } from '@mt/domain';
import { routeHandler, jsonOk } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { completeUpload } from '@/lib/services/media-service';

export const dynamic = 'force-dynamic';

/**
 * Receives the file bytes. The declared content type is ignored for the decision:
 * the real type is sniffed from the magic bytes and the size is enforced again
 * server side.
 */
export const POST = routeHandler<{ mediaId: string }>(
  '/api/v1/media/[mediaId]/upload',
  async (request, { params }) => {
    const { user } = await requireAuthenticatedAccess(request);
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      throw new AppError('BAD_REQUEST', 'expected a multipart upload with a `file` field');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return jsonOk(
      await completeUpload({
        actor: user,
        mediaId: params.mediaId,
        bytes,
        declaredMimeType: file.type,
      }),
    );
  },
);

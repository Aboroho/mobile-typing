import { createMediaIntentSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { createUploadIntent } from '@/lib/services/media-service';

export const dynamic = 'force-dynamic';

export const POST = routeHandler('/api/v1/media/upload-intent', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const input = parseWith(createMediaIntentSchema, await readJson(request));
  return jsonOk(
    await createUploadIntent({
      actor: user,
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      durationMs: input.durationMs,
      width: input.width,
      height: input.height,
    }),
    201,
  );
});

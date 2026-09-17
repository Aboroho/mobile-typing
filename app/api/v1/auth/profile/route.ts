import { updateProfileSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAuthenticatedAccess } from '@/lib/auth/guard';
import { updateProfile } from '@/lib/services/user-service';

export const dynamic = 'force-dynamic';

export const PATCH = routeHandler('/api/v1/auth/profile', async (request) => {
  const { user } = await requireAuthenticatedAccess(request);
  const input = parseWith(updateProfileSchema, await readJson(request));
  const updated = await updateProfile({ actorId: user.id, name: input.name, photoUrl: input.photoUrl });
  return jsonOk({ user: updated });
});

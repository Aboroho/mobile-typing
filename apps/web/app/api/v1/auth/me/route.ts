import { routeHandler, jsonOk } from '@/lib/api/http';
import { resolveAuth } from '@/lib/auth/session';
import { toSessionUser } from '@/lib/services/user-service';

export const dynamic = 'force-dynamic';

export const GET = routeHandler('/api/v1/auth/me', async (request) => {
  const auth = await resolveAuth(request).catch(() => null);
  return jsonOk({ user: auth ? toSessionUser(auth.user) : null });
});

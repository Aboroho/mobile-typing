import { changeSecretCodeSchema } from '@mt/validation';
import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { requireAdminAccess } from '@/lib/auth/guard';
import { clientIp } from '@/lib/security/rate-limit';
import { changeSecretCode } from '@/lib/access/access-service';
import { secretCodeStatus } from '@/lib/services/admin-service';
import { writeAuditLog } from '@/lib/security/audit';

export const dynamic = 'force-dynamic';

/** Status only: the code itself is never returned to the panel. */
export const GET = routeHandler('/api/v1/admin/secret-code', async (request) => {
  const { user } = await requireAdminAccess(request);
  await writeAuditLog({
    actor: { id: user.id, email: user.email },
    action: 'secret_code.read',
    targetType: 'appConfig/access',
    targetId: 'access',
    ipAddress: clientIp(request),
  });
  return jsonOk({ status: await secretCodeStatus() });
});

/**
 * Rotating the code bumps the epoch, which immediately invalidates every
 * outstanding access session and challenge.
 */
export const POST = routeHandler('/api/v1/admin/secret-code', async (request) => {
  const { user } = await requireAdminAccess(request);
  const input = parseWith(changeSecretCodeSchema, await readJson(request));
  await changeSecretCode({
    code: input.code,
    strategy: input.strategy,
    actor: { id: user.id, email: user.email },
    ipAddress: clientIp(request),
  });
  return jsonOk({ status: await secretCodeStatus() });
});

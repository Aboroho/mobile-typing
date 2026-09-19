import { routeHandler, jsonOk } from '@/lib/api/http';
import { ensureAccessConfig } from '@/lib/access/access-service';
import { getData } from '@/lib/data';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** Liveness + configuration probe. Reveals nothing about private data. */
export const GET = routeHandler('/api/v1/health', async () => {
  const data = await getData();
  const config = await ensureAccessConfig();
  return jsonOk({
    ok: true,
    version: '2.0.0',
    dataProvider: data.name,
    authProvider: 'argon2-session',
    storageProvider: env().STORAGE_PROVIDER,
    time: new Date().toISOString(),
    access: {
      epoch: config.epoch,
      maxLength: config.maxLength,
      caseSensitive: config.caseSensitive,
      configured: Boolean(config.code),
    },
  });
});

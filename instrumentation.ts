/**
 * Next.js instrumentation hook — runs once when the server starts, before the
 * first request is served.
 *
 * Used to warm the access configuration so the very first visitor to the typing
 * game does not pay for (or trip over) the bootstrap, and to fail fast when the
 * environment is unusable.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logger } = await import('./lib/logger');
  try {
    const { ensureAccessConfig } = await import('./lib/access/access-service');
    const config = await ensureAccessConfig();
    logger.info('boot.ready', {
      epoch: config.epoch,
      maxLength: config.maxLength,
      dataProvider: process.env.DATA_PROVIDER ?? 'memory',
      authProvider: process.env.AUTH_PROVIDER ?? 'dev',
    });
  } catch (error) {
    logger.error('boot.failed', { error: String(error) });
  }
}

/**
 * Next.js instrumentation hook — runs once when the server starts, before the
 * first request is served.
 *
 * Used to review the environment (a Firebase provider without Firebase
 * credentials otherwise fails much later, as an unrelated-looking 401 or 500),
 * to warm the access configuration so the very first visitor to the typing game
 * does not pay for (or trip over) the bootstrap, and to fail fast when the
 * environment is unusable.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logger } = await import('./lib/logger');
  const { reportConfigIssues } = await import('./lib/diagnostics');
  // Before the bootstrap below: when the data provider cannot start, the
  // configuration review is what explains why.
  reportConfigIssues('boot');
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

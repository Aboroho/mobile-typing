#!/usr/bin/env tsx
/**
 * Standalone outbox worker (`npm run worker`).
 *
 * Re-publishes pending `OutboxEvent` rows to the realtime bus so reconnecting
 * clients can replay what they missed. `server.ts` already runs this worker
 * in-process; run this entrypoint instead when the worker should live in its
 * own process (e.g. a second systemd unit on a VPS, or any deployment where
 * the web tier scales independently).
 *
 * Poll interval and batch size come from `OUTBOX_POLL_INTERVAL_MS` and
 * `OUTBOX_BATCH_SIZE`. Shuts down cleanly on SIGINT/SIGTERM.
 */
import { env } from '../env';
import { logger } from '../logger';
import { runOutboxWorker } from '../realtime/outbox';

async function main(): Promise<void> {
  const configured = env();
  const worker = runOutboxWorker({
    pollMs: configured.OUTBOX_POLL_INTERVAL_MS,
    batchSize: configured.OUTBOX_BATCH_SIZE,
  });
  logger.info('worker.started', {
    pollMs: configured.OUTBOX_POLL_INTERVAL_MS,
    batchSize: configured.OUTBOX_BATCH_SIZE,
    dataProvider: configured.DATA_PROVIDER,
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('worker.stopping', { signal });
    try {
      await worker.stop();
    } finally {
      process.exit(0);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error: unknown) => {
  logger.error('worker.failed', { error: String(error) });
  process.exit(1);
});

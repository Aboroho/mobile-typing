/**
 * Standalone Node server that mounts Next.js AND the authenticated WebSocket
 * server on the same port. Used for production deployments (run via
 * `tsx server.ts`). `next dev` / `next start` still work but WebSocket upgrades
 * won't be handled (clients fall back to SSE).
 *
 * Two WebSocket endpoints share this port: the Keypad realtime socket at
 * `/api/v1/ws`, and — in development — Next.js' own HMR socket at
 * `/_next/hmr`, which Next serves through an `upgrade` listener it attaches to
 * this same server on the first request. Only the former is handed to the
 * Keypad server; see lib/ws/upgrade.ts for why the latter must be left alone.
 */
// Must be the first import: it exposes AsyncLocalStorage before Next loads.
import './lib/server/async-local-storage-shim';
import { createServer } from 'node:http';
import next from 'next';
import { parse } from 'node:url';
import { createKeypadWSServer } from './lib/ws/server';
import { createUpgradeListener } from './lib/ws/upgrade';
import { runOutboxWorker } from './lib/realtime/outbox';
import { logger } from './lib/logger';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const ws = createKeypadWSServer({ path: '/api/v1/ws' });
const outbox = runOutboxWorker({ pollMs: dev ? 250 : 500, batchSize: 200 });
logger.info('server.started', { port, wsPath: '/api/v1/ws', dev });

const server = createServer((req, res) => {
  try {
    const parsed = parse(req.url ?? '/', true);
    void handle(req, res, parsed);
  } catch (err) {
    console.error('request error', err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

// Registered before Next's own listener (which Next adds lazily), so this runs
// first for every upgrade: it must only claim `/api/v1/ws` and leave Next's
// dev sockets untouched, otherwise HMR dies and the page never hydrates.
server.on('upgrade', createUpgradeListener(ws, { dev }));

server.listen(port, hostname, () => {
  // eslint-disable-next-line no-console
  console.log(`> Keypad server ready on http://${hostname}:${port} (ws: /api/v1/ws)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // eslint-disable-next-line no-console
    console.log(`> ${signal} received, shutting down...`);
    void ws.close().then(() => outbox.stop()).then(() => app.close().then(() => process.exit(0)));
  });
}

/**
 * Standalone Node server that mounts Next.js AND the authenticated WebSocket
 * server on the same port. Used for production deployments (run via
 * `tsx server.ts`). `next dev` / `next start` still work but WebSocket upgrades
 * won't be handled (clients fall back to SSE).
 */
import { createServer } from 'node:http';
import next from 'next';
import { parse } from 'node:url';
import { createKeypadWSServer } from './lib/ws/server';
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

server.on('upgrade', (req, socket, head) => {
  ws.handleUpgrade(req, socket as unknown as import('node:net').Socket, head as unknown as Buffer);
});

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

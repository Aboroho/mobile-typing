/**
 * Regression test for "Loading words…" under `npm run dev` with the HMR
 * socket failing:
 *
 *   WebSocket connection to 'ws://192.168.0.108:3000/_next/hmr?id=…' failed:
 *   Connection closed before receiving a handshake response
 *
 * server.ts mounts Next.js and the Keypad realtime socket on one port. Next
 * adds its *own* `upgrade` listener to that server after the first request, so
 * two listeners see every upgrade and ours — registered first — runs first.
 * The old listener handed every socket to the Keypad server, which destroyed
 * anything that was not `/api/v1/ws`, so Next never got to answer its HMR
 * handshake: the browser retried a dozen times, force-reloaded, and the page
 * stayed on "Loading words…". Nothing was logged because nothing threw.
 *
 * This wires a real `http.Server` the same way — our listener first, a stand-in
 * for Next's HMR listener second — and checks each path ends up with the
 * right owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createKeypadWSServer, type KeypadWSServer } from '@/lib/ws/server';
import { createUpgradeListener, routeUpgrade } from '@/lib/ws/upgrade';

describe('routeUpgrade', () => {
  const dev = { wsPath: '/api/v1/ws', dev: true };
  const prod = { wsPath: '/api/v1/ws', dev: false };

  it('claims exactly the Keypad realtime path (query string ignored)', () => {
    expect(routeUpgrade('/api/v1/ws', dev)).toBe('keypad');
    expect(routeUpgrade('/api/v1/ws?since=evt_1', prod)).toBe('keypad');
    expect(routeUpgrade('/api/v1/ws/other', dev)).toBe('reject');
  });

  it("leaves Next's development sockets to Next", () => {
    expect(routeUpgrade('/_next/hmr?id=8dLK_87At4h0Fa98-RFUF', dev)).toBe('next');
    // `basePath`/`assetPrefix` put a segment in front of the HMR path.
    expect(routeUpgrade('/keypad/_next/hmr?id=abc', dev)).toBe('next');
  });

  it('has nothing to hand to Next in production, so unknown paths are rejected', () => {
    expect(routeUpgrade('/_next/hmr?id=abc', prod)).toBe('reject');
    expect(routeUpgrade('/socket.io/?EIO=4', dev)).toBe('reject');
    expect(routeUpgrade(undefined, dev)).toBe('reject');
  });
});

describe('server upgrade listener (Next listener registered after ours, as in server.ts)', () => {
  let httpServer: Server;
  let keypad: KeypadWSServer;
  let hmr: WebSocketServer;
  let port = 0;
  const hmrHandshakes: string[] = [];

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    keypad = createKeypadWSServer({ path: '/api/v1/ws' });

    // 1. Our listener, exactly as server.ts installs it.
    httpServer.on('upgrade', createUpgradeListener(keypad, { dev: true }));

    // 2. A stand-in for the listener Next.js attaches to the same server: it
    //    answers `/_next/hmr` and ignores everything else (Next's real one does
    //    the same for unmatched paths, "as a custom WS server may be listening").
    hmr = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/_next/hmr')) return;
      hmrHandshakes.push(req.url);
      hmr.handleUpgrade(req, socket as Socket, head, (client) => {
        client.send(JSON.stringify({ type: 'turbopack-connected', data: { sessionId: 1 } }));
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await keypad.close();
    await new Promise<void>((resolve) => hmr.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function open(
    path: string,
  ): Promise<{ status: number | null; firstMessage: string | null; error: string | null }> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { origin: 'http://192.168.0.108:3000' },
        handshakeTimeout: 3000,
      });
      socket.once('message', (raw) => {
        socket.close();
        resolve({ status: 101, firstMessage: raw.toString('utf8'), error: null });
      });
      socket.once('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode ?? null, firstMessage: null, error: null });
      });
      socket.once('error', (error) =>
        resolve({ status: null, firstMessage: null, error: error.message }),
      );
    });
  }

  it("completes Next's HMR handshake instead of closing the socket first", async () => {
    const result = await open('/_next/hmr?id=8dLK_87At4h0Fa98-RFUF');
    // Before the fix this was `{ status: null, error: 'socket hang up' }` — the
    // browser's "Connection closed before receiving a handshake response".
    expect(result.error).toBeNull();
    expect(result.status).toBe(101);
    expect(JSON.parse(result.firstMessage ?? '{}')).toMatchObject({ type: 'turbopack-connected' });
    expect(hmrHandshakes).toHaveLength(1);
  });

  it('still routes the realtime path to the Keypad server (401 without a session)', async () => {
    const result = await open('/api/v1/ws');
    expect(result.status).toBe(401);
    expect(hmrHandshakes).toHaveLength(1); // untouched by the HMR stand-in
  });

  it('answers paths nobody serves with 404 rather than hanging up silently', async () => {
    const result = await open('/socket.io/?EIO=4');
    expect(result.status).toBe(404);
  });
});

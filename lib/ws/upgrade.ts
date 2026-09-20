/**
 * Routes HTTP `upgrade` requests on the standalone server (server.ts).
 *
 * One port carries two WebSocket endpoints:
 *
 *  - `/api/v1/ws` — the authenticated Keypad realtime socket (lib/ws/server.ts);
 *  - `/_next/hmr` — Next.js' own development socket (hot reload, the dev
 *    overlay, Turbopack updates). Next attaches its *own* `upgrade` listener to
 *    the very same `http.Server` when the first page request goes through
 *    `app.getRequestHandler()`, and that listener answers the HMR handshake.
 *
 * Node runs `upgrade` listeners in registration order, so ours always sees the
 * socket first. Anything it does to a socket it does not own — `destroy()`,
 * writing a 4xx — happens *before* Next gets a chance to answer, and the
 * browser reports "WebSocket connection to 'ws://…/_next/hmr' failed:
 * Connection closed before receiving a handshake response". Nothing is logged
 * on the server because nothing threw. The client then retries a dozen times
 * and force-reloads the page, so the typing game sits on "Loading words…"
 * instead of hydrating. Leaving Next's sockets alone is the whole fix.
 */
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { KeypadWSServer } from './server';

export type UpgradeRoute = 'keypad' | 'next' | 'reject';

export interface UpgradeRouteOptions {
  /** Path of the Keypad realtime socket, e.g. `/api/v1/ws`. */
  wsPath: string;
  /** `true` while `next dev` tooling (HMR) is mounted on this server. */
  dev: boolean;
}

/**
 * Decides who answers an `upgrade` request for `url`.
 *
 *  - `keypad`: hand the socket to the Keypad WebSocket server;
 *  - `next`: do nothing — Next.js' own listener on the same server answers
 *    (development only; a production build has no upgrade endpoints of its own);
 *  - `reject`: nobody serves this path, close it with a 404.
 */
export function routeUpgrade(url: string | undefined, options: UpgradeRouteOptions): UpgradeRoute {
  let pathname: string;
  try {
    pathname = new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return 'reject';
  }
  if (pathname === options.wsPath) return 'keypad';
  // `/_next/hmr` today, plus whatever else Next mounts under its private prefix
  // (a `basePath`/`assetPrefix` puts a segment in front of it).
  if (options.dev && pathname.includes('/_next/')) return 'next';
  return 'reject';
}

/**
 * The `upgrade` listener installed by server.ts. Kept separate so the routing
 * can be exercised over a real socket in tests without booting Next.
 */
export function createUpgradeListener(
  ws: KeypadWSServer,
  options: { dev: boolean },
): (req: IncomingMessage, socket: Socket, head: Buffer) => void {
  return (req, socket, head) => {
    switch (routeUpgrade(req.url, { wsPath: ws.path, dev: options.dev })) {
      case 'keypad':
        ws.handleUpgrade(req, socket, head);
        return;
      case 'next':
        // Next.js answers this one. Do not touch the socket.
        return;
      case 'reject':
      default:
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
    }
  };
}

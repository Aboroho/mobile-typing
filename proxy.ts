import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge proxy (Next 16's replacement for middleware).
 *
 * Responsibilities:
 *  - security headers, including a Content-Security-Policy that allows same-origin
 *    API/SSE traffic and `blob:` for local media playback;
 *  - a request id so server logs can be correlated with a single browser action.
 *
 * Authorisation is *not* done here: it happens in the API routes, where the
 * session token and the access session are verified against the database.
 *
 * The CSP is nonce-based rather than relying on `'unsafe-inline'`: the App
 * Router hydrates the page with inline `<script>` tags (`self.__next_f.push`,
 * the RSC flight data, etc.), so a `script-src 'self'` policy with no
 * `'unsafe-inline'`/nonce blocks every one of them outright — the app never
 * hydrates and appears to hang (e.g. "Loading words…" forever). Next.js reads
 * the nonce back out of this header and stamps it onto its own inline
 * scripts automatically, so no other code has to know about it.
 * See: https://nextjs.org/docs/app/guides/content-security-policy
 */
function buildCsp(nonce: string, origin: string | null): string {
  const isDev = process.env.NODE_ENV === 'development';
  // CSP3 'self' already matches ws:/wss: for the page's own host and port, but
  // spelling the socket origin out costs nothing and keeps the realtime socket
  // (and, in development, Next's HMR socket) working on engines that still
  // apply the CSP2 reading, where 'self' meant http(s) only.
  const wsSources = origin ? ` ${origin.replace(/^http/, 'ws')}` : '';
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonce-bearing framework scripts load whatever
    // scripts they themselves inject, without falling back to 'unsafe-inline'.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "font-src 'self' data:",
    `connect-src 'self'${wsSources}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * The origin the *browser* used to reach us, e.g. `http://192.168.0.108:3000`
 * for a phone on the Wi-Fi or `https://keypad.example` behind nginx.
 *
 * `request.nextUrl.origin` is not that: Next builds it from the address the
 * server was started on (`0.0.0.0:3000` under `npm run dev`, `localhost:3000`
 * under `next dev`), whatever the client typed. Deriving the ws/wss source in
 * the CSP from it produced `connect-src … ws://0.0.0.0:3000`, which matches
 * nothing. The `Host` header (or `X-Forwarded-Host`/`-Proto` from a reverse
 * proxy) is what the browser will compare the policy against.
 */
export function requestOrigin(request: NextRequest): string | null {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host'))
    ?.split(',')[0]
    ?.trim();
  // HTTP/1.1 always carries `Host`; the fallback only matters for synthetic
  // requests (tests) and still beats emitting nothing.
  if (!host) return request.nextUrl?.origin ?? null;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto || request.nextUrl?.protocol?.replace(/:$/, '') || 'http';
  return `${protocol}://${host}`;
}

/** `localhost`, loopback IPs and `https` count as *potentially trustworthy*. */
export function isTrustworthyOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return true;
    const host = url.hostname;
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const origin = requestOrigin(request);

  // The nonce must reach Next's own renderer via the *request* headers (so it
  // can stamp framework scripts with it), not just the response.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('x-request-id', requestId);

  // ENABLE_SECURITY_HEADERS=false is an escape hatch for local debugging only.
  const securityHeadersEnabled = process.env.ENABLE_SECURITY_HEADERS !== 'false';
  if (!securityHeadersEnabled) return response;

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), geolocation=(), interest-cohort=(), microphone=(self)',
  );
  // Browsers only honour COOP on a potentially trustworthy origin (https, or
  // localhost). On a plain-http LAN address — a phone opening the dev server
  // at http://192.168.x.x:3000 — Chrome ignores it and prints "The
  // Cross-Origin-Opener-Policy header has been ignored, because the URL's
  // origin was untrustworthy" on every page load. That warning is harmless
  // but reads like an error, so skip the header where it cannot apply anyway.
  // Production keeps it unconditionally: a TLS-terminating proxy that forgets
  // `X-Forwarded-Proto` must not silently drop a security header.
  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev || isTrustworthyOrigin(origin)) {
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  }

  const cspMode = process.env.CSP_MODE ?? 'enforce';
  if (cspMode === 'off') return response;

  const csp = buildCsp(nonce, origin);
  const headerName =
    cspMode === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  response.headers.set(headerName, csp);

  return response;
}

export const config = {
  // Skip Next's own static assets; everything else gets the headers.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt).*)'],
};

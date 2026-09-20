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
  // `connect-src 'self'` covers http(s) to this origin. WebSocket upgrades need
  // the ws/wss scheme spelled out for the *same* host, otherwise the realtime
  // socket is blocked by CSP and silently falls back to SSE.
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

export function proxy(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const origin = request.nextUrl?.origin ?? null;

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
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');

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

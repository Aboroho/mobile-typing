import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge proxy (Next 16's replacement for middleware).
 *
 * Responsibilities:
 *  - security headers, including a Content-Security-Policy that allows same-origin
 *    API/SSE traffic, Firebase endpoints when configured, and `blob:` for local
 *    media playback;
 *  - a request id so server logs can be correlated with a single browser action.
 *
 * Authorisation is *not* done here: it happens in the API routes, where the
 * Firebase ID token and the access session are verified against the database.
 */
const CSP = [
  "default-src 'self'",
  // Inline styles are emitted by Tailwind/React; scripts stay external.
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com wss://*.firebaseio.com wss://*.googleapis.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  response.headers.set('x-request-id', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), geolocation=(), interest-cohort=(), microphone=(self)');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Content-Security-Policy', CSP);
  return response;
}

export const config = {
  // Skip Next's own static assets; everything else gets the headers.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt).*)'],
};

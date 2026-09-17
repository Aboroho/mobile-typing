/**
 * Regression test for the "Loading words…" hang.
 *
 * The App Router hydrates every page with inline `<script>` tags
 * (`self.__next_f.push(...)`, the RSC flight data). A `script-src 'self'`
 * CSP with no `'unsafe-inline'`/nonce makes every browser block those
 * scripts outright, so React never hydrates: interactive UI (the Start
 * button, the "Loading words…" spinner) is stuck forever because the click
 * handlers and state updates that would resolve it never attach.
 *
 * The fix is a per-request nonce: the proxy puts it in both the
 * `Content-Security-Policy` response header and the `x-nonce` *request*
 * header, and Next.js reads the latter back out during rendering to stamp
 * its own inline scripts with it. This test asserts that contract holds.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

function extractNonce(csp: string | null): string | null {
  if (!csp) return null;
  const match = /'nonce-([^']+)'/.exec(csp);
  return match?.[1] ?? null;
}

describe('proxy CSP', () => {
  it('emits a script-src nonce that also reaches Next via the request headers', () => {
    const request = new NextRequest('http://localhost:3000/');
    const response = proxy(request);

    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();

    const headerNonce = extractNonce(csp);
    expect(headerNonce).toBeTruthy();

    // Next.js extracts the nonce from the *request* header during rendering
    // (see nextjs.org/docs/app/guides/content-security-policy) — without this,
    // the nonce in the response header would never reach the renderer and
    // every inline hydration script would be stamped with nothing, i.e. still
    // blocked. `NextResponse.next({ request: { headers } })` encodes the
    // forwarded request headers as `x-middleware-request-*` response headers,
    // which Next's runtime later replays onto the actual downstream request.
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(headerNonce);

    // script-src must never fall back to 'unsafe-inline': that would silently
    // reopen the XSS hole the CSP exists to close. (style-src legitimately
    // keeps 'unsafe-inline' for Tailwind's inline styles — only script-src
    // is asserted here.)
    const scriptSrc = /script-src[^;]*/.exec(csp ?? '')?.[0] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it('mints a fresh nonce on every request', () => {
    const first = proxy(new NextRequest('http://localhost:3000/'));
    const second = proxy(new NextRequest('http://localhost:3000/'));

    const firstNonce = extractNonce(first.headers.get('Content-Security-Policy'));
    const secondNonce = extractNonce(second.headers.get('Content-Security-Policy'));

    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });

  it('still sets the other security headers', () => {
    const response = proxy(new NextRequest('http://localhost:3000/'));
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

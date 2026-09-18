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
 * `Content-Security-Policy` response AND request headers (plus `x-nonce`),
 * and Next.js reads the request CSP during rendering to stamp
 * its own inline scripts with it. This test asserts that contract holds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

function extractNonce(csp: string | null): string | null {
  if (!csp) return null;
  const match = /'nonce-([^']+)'/.exec(csp);
  return match?.[1] ?? null;
}

afterEach(() => vi.unstubAllEnvs());

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
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);

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

describe('CSP modes and development previews', () => {
  it('also forwards the nonce-bearing policy in report-only mode', () => {
    vi.stubEnv('CSP_MODE', 'report');
    const response = proxy(
      new NextRequest('http://localhost:3000/', {
        headers: { 'Content-Security-Policy': "script-src 'nonce-untrusted'" },
      }),
    );
    const policy = response.headers.get('Content-Security-Policy-Report-Only');
    expect(extractNonce(policy)).toBeTruthy();
    expect(response.headers.get('x-middleware-request-content-security-policy-report-only')).toBe(
      policy,
    );
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBeNull();
  });

  it('allows only explicitly configured development frame parents', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DEV_FRAME_ANCESTORS', 'https://preview.example');
    const response = proxy(new NextRequest('http://localhost:3000/'));
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'frame-ancestors https://preview.example',
    );
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('never allows preview framing in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEV_FRAME_ANCESTORS', 'https://preview.example');
    const response = proxy(new NextRequest('http://localhost:3000/'));
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-eval');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

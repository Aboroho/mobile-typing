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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { isTrustworthyOrigin, proxy, requestOrigin } from '../proxy';

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

  // `request.nextUrl.origin` is the address the server was *started* on
  // (`0.0.0.0:3000` under `npm run dev`), not the one the browser typed. The
  // ws/wss source in connect-src used to be built from it, which produced
  // `ws://0.0.0.0:3000` for every visitor — matching nothing.
  it('allows the realtime socket on the origin the browser actually used', () => {
    const phone = proxy(
      new NextRequest('http://0.0.0.0:3000/', { headers: { host: '192.168.0.108:3000' } }),
    );
    expect(connectSrc(phone)).toBe("connect-src 'self' ws://192.168.0.108:3000");

    const behindTls = proxy(
      new NextRequest('http://0.0.0.0:3000/', {
        headers: {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'keypad.example',
          'x-forwarded-proto': 'https',
        },
      }),
    );
    expect(connectSrc(behindTls)).toBe("connect-src 'self' wss://keypad.example");
  });

  it('exposes the browser-facing origin for other headers to reuse', () => {
    expect(
      requestOrigin(
        new NextRequest('http://0.0.0.0:3000/', { headers: { host: 'laptop.local:3000' } }),
      ),
    ).toBe('http://laptop.local:3000');
    // No Host header at all (synthetic requests): fall back to the URL.
    expect(requestOrigin(new NextRequest('http://localhost:3000/'))).toBe('http://localhost:3000');
  });

  describe('Cross-Origin-Opener-Policy', () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      vi.stubEnv('NODE_ENV', originalEnv ?? 'test');
    });

    it('is only sent in development where the browser would honour it', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const lan = proxy(
        new NextRequest('http://0.0.0.0:3000/', { headers: { host: '192.168.0.108:3000' } }),
      );
      // Chrome ignores COOP on a plain-http LAN origin and logs "The
      // Cross-Origin-Opener-Policy header has been ignored, because the URL's
      // origin was untrustworthy" — pure noise while testing from a phone.
      expect(lan.headers.get('Cross-Origin-Opener-Policy')).toBeNull();

      const local = proxy(
        new NextRequest('http://0.0.0.0:3000/', { headers: { host: 'localhost:3000' } }),
      );
      expect(local.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');

      const https = proxy(
        new NextRequest('http://0.0.0.0:3000/', {
          headers: { host: 'dev.example', 'x-forwarded-proto': 'https' },
        }),
      );
      expect(https.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    });

    it('is always sent outside development', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const lan = proxy(
        new NextRequest('http://0.0.0.0:3000/', { headers: { host: '192.168.0.108:3000' } }),
      );
      expect(lan.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    });
  });

  it('classifies potentially trustworthy origins like the browser does', () => {
    expect(isTrustworthyOrigin('https://192.168.0.108:3000')).toBe(true);
    expect(isTrustworthyOrigin('http://localhost:3000')).toBe(true);
    expect(isTrustworthyOrigin('http://app.localhost:3000')).toBe(true);
    expect(isTrustworthyOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isTrustworthyOrigin('http://192.168.0.108:3000')).toBe(false);
    expect(isTrustworthyOrigin('http://laptop.local:3000')).toBe(false);
    expect(isTrustworthyOrigin(null)).toBe(false);
  });
});

function connectSrc(response: Response): string | undefined {
  return /connect-src[^;]*/.exec(response.headers.get('Content-Security-Policy') ?? '')?.[0];
}

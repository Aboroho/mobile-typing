import { createApiClient, type ApiClient } from '@mt/api-client';

/**
 * Single API client for the browser.
 *
 * Credentials travel in the httpOnly session cookie the API sets (plus an
 * optional `Authorization: Bearer` session token for non-browser callers), so
 * no call site ever handles a token directly.
 */
let cached: ApiClient | null = null;
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setAuthTokenProvider(provider: () => Promise<string | null>): void {
  tokenProvider = provider;
  cached = null;
}

function client(): ApiClient {
  if (!cached) {
    cached = createApiClient({
      getToken: tokenProvider ?? (async () => null),
      onResponse: ({ code }) => {
        if (code === 'ACCESS_REQUIRED') {
          // The access session expired or was revoked: fall back to the game.
          globalThis.dispatchEvent(new CustomEvent('mt:access-required'));
        }
        if (code === 'UNAUTHENTICATED' || code === 'ACCOUNT_DISABLED') {
          // The session expired, was revoked by a logout or an administrator, or
          // the credential could not be refreshed: drop the user so the sign-in
          // panel returns instead of every later request failing quietly.
          globalThis.dispatchEvent(new CustomEvent('mt:auth-required'));
        }
      },
    });
  }
  return cached;
}

/** Lazily resolves to the real client, keeping import order trivial. */
export const api: ApiClient = new Proxy({} as ApiClient, {
  get(_target, property: string | symbol) {
    const value = (client() as unknown as Record<string | symbol, unknown>)[property];
    return typeof value === 'function' ? value.bind(client()) : value;
  },
});

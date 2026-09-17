import { createApiClient, type ApiClient } from '@mt/api-client';

/**
 * Single API client for the browser.
 *
 * Credentials are supplied by the auth client (a Firebase ID token when
 * configured, otherwise the httpOnly dev session cookie), so no call site ever
 * handles a token directly.
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

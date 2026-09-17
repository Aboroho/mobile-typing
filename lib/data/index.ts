import { env, assertFallbackAllowed } from '../env';
import { logger } from '../logger';
import { createMemoryDataProvider } from './memory';
import type { DataProvider } from './types';

export type { DataProvider };
export * from './types';
export { resetStore } from './memory/store';

let cached: DataProvider | null = null;
let cachedName: string | null = null;

/**
 * Resolves the persistence backend once per process.
 *
 * `DATA_PROVIDER=firestore` uses Cloud Firestore through the Admin SDK.
 * `DATA_PROVIDER=memory` (the default for local development and tests) keeps
 * everything in process memory and is refused outright in production, so a
 * misconfigured deployment fails loudly instead of quietly losing data.
 */
export async function getData(): Promise<DataProvider> {
  const configured = env().DATA_PROVIDER;
  if (cached && cachedName === configured) return cached;

  if (configured === 'firestore') {
    const { createFirestoreDataProvider } = await import('./firestore/index');
    cached = createFirestoreDataProvider();
  } else {
    assertFallbackAllowed('in-memory data');
    cached = createMemoryDataProvider();
  }
  cachedName = configured;
  logger.info('data.provider.selected', { provider: cached.name });
  return cached;
}

/** Test helper: drop the cached provider (used together with `resetStore`). */
export function resetDataProvider(): void {
  cached = null;
  cachedName = null;
}

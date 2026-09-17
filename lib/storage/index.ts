import { assertFallbackAllowed, env } from '../env';
import { logger } from '../logger';
import { createFirebaseStorageProvider } from './firebase';
import { createMemoryStorageProvider } from './memory';
import type { StorageProvider } from './types';

export type { StorageProvider, StoredObject } from './types';
export { resetMemoryStorage } from './memory';

let cached: StorageProvider | null = null;
let cachedName: string | null = null;

export function getStorage(): StorageProvider {
  const configured = env().STORAGE_PROVIDER;
  if (cached && cachedName === configured) return cached;
  if (configured === 'firebase') {
    cached = createFirebaseStorageProvider();
  } else {
    assertFallbackAllowed('in-memory storage');
    cached = createMemoryStorageProvider();
  }
  cachedName = configured;
  logger.info('storage.provider.selected', { provider: cached.name });
  return cached;
}

export function resetStorageProvider(): void {
  cached = null;
  cachedName = null;
}

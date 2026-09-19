import { assertFallbackAllowed, env } from '../env';
import { logger } from '../logger';
import { createMemoryStorageProvider } from './memory';
import { createLocalStorageProvider } from './local';
import { createS3StorageProvider } from './s3';
import type { StorageProvider } from './types';

export type { StorageProvider, StoredObject, SignedUpload } from './types';
export { resetMemoryStorage } from './memory';
export { verifyHmac } from './local';

let cached: StorageProvider | null = null;
let cachedName: string | null = null;

export function getStorage(): StorageProvider {
  const configured = env().STORAGE_PROVIDER;
  if (cached && cachedName === configured) return cached;
  if (configured === 's3') {
    cached = createS3StorageProvider();
  } else if (configured === 'local') {
    cached = createLocalStorageProvider();
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

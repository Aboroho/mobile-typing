import type { StorageProvider, StoredObject } from './types';

interface MemoryBucket {
  objects: Map<string, StoredObject>;
}

const GLOBAL_KEY = '__mt_memory_storage_v1';

function bucket(): MemoryBucket {
  const target = globalThis as unknown as Record<string, MemoryBucket | undefined>;
  if (!target[GLOBAL_KEY]) target[GLOBAL_KEY] = { objects: new Map() };
  return target[GLOBAL_KEY] as MemoryBucket;
}

/** Development storage: bytes stay in process memory and are never written to disk. */
export function createMemoryStorageProvider(): StorageProvider {
  return {
    name: 'memory',
    async put(path, bytes, contentType) {
      bucket().objects.set(path, { bytes: new Uint8Array(bytes), contentType });
      return { path, sizeBytes: bytes.byteLength };
    },
    async get(path) {
      const object = bucket().objects.get(path);
      return object ? { bytes: new Uint8Array(object.bytes), contentType: object.contentType } : null;
    },
    async createSignedUrl() {
      // No signing in development; the API streams the bytes instead.
      return null;
    },
    async exists(path) {
      return bucket().objects.has(path);
    },
  };
}

/** Test helper. */
export function resetMemoryStorage(): void {
  const target = globalThis as unknown as Record<string, MemoryBucket | undefined>;
  delete target[GLOBAL_KEY];
}

import { getStorageBucket } from '../firebase/admin';
import type { StorageProvider } from './types';

/**
 * Firebase Cloud Storage implementation. Objects are written private and only
 * exposed through short lived signed URLs minted by an authorised API route, so
 * a soft-deleted attachment can never be reached through a stale public link.
 */
export function createFirebaseStorageProvider(): StorageProvider {
  return {
    name: 'firebase',
    async put(path, bytes, contentType) {
      const file = getStorageBucket().file(path);
      await file.save(Buffer.from(bytes), {
        contentType,
        resumable: false,
        metadata: { cacheControl: 'private, no-store' },
      });
      return { path, sizeBytes: bytes.byteLength };
    },
    async get(path) {
      const file = getStorageBucket().file(path);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [bytes] = await file.download();
      const [metadata] = await file.getMetadata();
      return {
        bytes: new Uint8Array(bytes),
        contentType: metadata.contentType ?? 'application/octet-stream',
      };
    },
    async createSignedUrl(path, ttlSeconds, contentType) {
      const file = getStorageBucket().file(path);
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + ttlSeconds * 1000,
        responseDisposition: 'inline',
        contentType,
      });
      return url;
    },
    async exists(path) {
      const [exists] = await getStorageBucket().file(path).exists();
      return exists;
    },
  };
}

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Media storage boundary.
 *
 * Two rules hold for every implementation: objects are private (no public URL
 * is ever produced) and nothing is ever physically deleted — soft deletion is a
 * database flag, so administrators can still inspect what a user removed.
 */
export interface StorageProvider {
  readonly name: 'memory' | 'firebase';
  put(path: string, bytes: Uint8Array, contentType: string): Promise<{ path: string; sizeBytes: number }>;
  get(path: string): Promise<StoredObject | null>;
  /** Short lived, capability style URL. `null` when the backend cannot sign. */
  createSignedUrl(path: string, ttlSeconds: number, contentType: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
}

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface SignedUpload {
  uploadUrl: string;
  objectKey: string;
  /** Provider-specific fields the client must include in the PUT (e.g. form fields). */
  fields: Record<string, string>;
  headers: Record<string, string>;
  method: 'PUT' | 'POST';
  /** Expiration as ISO timestamp. */
  expiresAt: string;
}

/**
 * Media storage boundary.
 *
 * Every implementation keeps objects private: no permanent public URL is ever
 * produced. Soft deletion is a database flag so administrators can inspect
 * what users removed.
 */
export interface StorageProvider {
  readonly name: 'memory' | 'local' | 's3';

  /** Direct put from server (used for tests, migrations and small binary ops). */
  put(path: string, bytes: Uint8Array, contentType: string): Promise<{ path: string; sizeBytes: number }>;
  get(path: string): Promise<StoredObject | null>;
  exists(path: string): Promise<boolean>;

  /** Short-lived signed download URL. Returns null when not supported. */
  createSignedUrl(path: string, ttlSeconds: number, contentType?: string): Promise<string | null>;

  /** Short-lived signed upload URL for direct client-to-storage uploads. */
  createSignedUpload?(
    path: string,
    ttlSeconds: number,
    contentType: string,
    maxBytes: number,
  ): Promise<SignedUpload>;

  /** Verifies that an uploaded object exists and returns its size + content-type. */
  confirmUpload?(path: string): Promise<{ sizeBytes: number; contentType: string } | null>;

  /** Delete object data physically. Only invoked by admin purge flows. */
  hardDelete?(path: string): Promise<void>;
}

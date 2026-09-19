/**
 * Local filesystem storage provider.
 *
 * Writes objects under a configurable directory (STORAGE_LOCAL_DIR). Suitable
 * for single-server VPS deployments and local development. NOT suitable for
 * multi-server deployments (use `s3` in that case).
 *
 * "Signed" URLs are actually authenticated API routes under
 * `/api/v1/media/[mediaId]/content` — the local provider returns a relative
 * URL so the browser hits our API, which authorizes the request and streams
 * bytes from disk. Object keys are random/unguessable, but we still enforce
 * authorization at the API layer.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../env';
import type { StoredObject, StorageProvider } from './types';

export function createLocalStorageProvider(rootDir?: string): StorageProvider {
  const baseDir = path.resolve(rootDir ?? env().STORAGE_LOCAL_DIR);

  async function ensureDir(): Promise<void> {
    await fs.mkdir(baseDir, { recursive: true });
  }

  function keyToPath(key: string): string {
    // Prevent traversal: only the base36-like keys we generate are allowed.
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path.join(baseDir, key);
  }

  return {
    name: 'local',
    async put(objectKey: string, bytes: Uint8Array, contentType: string) {
      await ensureDir();
      const filePath = keyToPath(objectKey);
      const metaPath = filePath + '.meta.json';
      await fs.writeFile(filePath, bytes);
      await fs.writeFile(
        metaPath,
        JSON.stringify({ contentType, sizeBytes: bytes.length, createdAt: new Date().toISOString() }),
      );
      return { path: objectKey, sizeBytes: bytes.length };
    },
    async get(objectKey: string): Promise<StoredObject | null> {
      try {
        const filePath = keyToPath(objectKey);
        const metaPath = filePath + '.meta.json';
        const [bytes, metaRaw] = await Promise.all([fs.readFile(filePath), fs.readFile(metaPath, 'utf8')]);
        const meta = JSON.parse(metaRaw) as { contentType: string };
        return { bytes: new Uint8Array(bytes), contentType: meta.contentType };
      } catch {
        return null;
      }
    },
    async exists(objectKey: string): Promise<boolean> {
      try {
        await fs.access(keyToPath(objectKey));
        return true;
      } catch {
        return false;
      }
    },
    async createSignedUrl(objectKey: string, _ttlSeconds: number): Promise<string | null> {
      // The local provider does not produce CDN URLs; the API route
      // `/api/v1/media/[mediaId]/content` streams the bytes after authorization.
      // We return a deterministic signed token that the route validates.
      const sig = await hmacSign(objectKey);
      return `/api/v1/media/_local/${encodeURIComponent(objectKey)}?sig=${encodeURIComponent(sig)}`;
    },
  };
}

async function hmacSign(key: string): Promise<string> {
  const secret = env().APP_SECRET;
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', await importKey(secret), enc.encode(key));
  return Buffer.from(sig).toString('base64url');
}

let _cryptoKey: CryptoKey | null = null;
async function importKey(secret: string): Promise<CryptoKey> {
  if (_cryptoKey) return _cryptoKey;
  _cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return _cryptoKey;
}

export async function verifyHmac(key: string, sig: string): Promise<boolean> {
  const expected = await hmacSign(key);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

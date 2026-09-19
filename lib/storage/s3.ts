// @ts-nocheck
/**
 * S3-compatible object storage provider.
 *
 * This implementation uses the AWS S3 v3 SDK. The SDK is imported dynamically
 * so the package is an optional dependency; STORAGE_PROVIDER=s3 throws a clear
 * error if the SDK is not installed.
 *
 * Install with:
 *
 *   npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 */
import { env } from '../env';
import { logger } from '../logger';
import type { StoredObject, StorageProvider } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _s3: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _presigner: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(): Promise<{ s3: any; presigner: any }> {
  if (_s3 && _presigner) return { s3: _s3, presigner: _presigner };
  try {
    _s3 = await import('@aws-sdk/client-s3');
    _presigner = await import('@aws-sdk/s3-request-presigner');
  } catch (err) {
    throw new Error(
      'STORAGE_PROVIDER=s3 requires the @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner packages. ' +
      'Install them with `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`. ' +
      `Underlying error: ${(err as Error).message}`,
    );
  }
  return { s3: _s3, presigner: _presigner };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeClient(): Promise<any> {
  const { s3 } = await load();
  const e = env();
  return new s3.S3Client({
    region: e.STORAGE_REGION,
    endpoint: e.STORAGE_ENDPOINT || undefined,
    forcePathStyle: e.STORAGE_FORCE_PATH_STYLE,
    credentials:
      e.STORAGE_ACCESS_KEY && e.STORAGE_SECRET_KEY
        ? { accessKeyId: e.STORAGE_ACCESS_KEY, secretAccessKey: e.STORAGE_SECRET_KEY }
        : undefined,
  });
}

export function createS3StorageProvider(): StorageProvider {
  return {
    name: 's3',
    async put(objectKey, bytes, contentType) {
      const { s3 } = await load();
      const c = await makeClient();
      await c.send(
        new s3.PutObjectCommand({
          Bucket: env().STORAGE_BUCKET,
          Key: objectKey,
          Body: bytes,
          ContentType: contentType,
        }),
      );
      return { path: objectKey, sizeBytes: bytes.length };
    },
    async get(objectKey): Promise<StoredObject | null> {
      const { s3 } = await load();
      const c = await makeClient();
      try {
        const res = await c.send(
          new s3.GetObjectCommand({ Bucket: env().STORAGE_BUCKET, Key: objectKey }),
        );
        const bytes = res.Body ? new Uint8Array(await res.Body.transformToByteArray()) : null;
        if (!bytes) return null;
        return { bytes, contentType: res.ContentType ?? 'application/octet-stream' };
      } catch (err) {
        logger.warn('storage.s3.get_failed', { key: objectKey, error: String(err) });
        return null;
      }
    },
    async exists(objectKey): Promise<boolean> {
      const { s3 } = await load();
      const c = await makeClient();
      try {
        await c.send(new s3.HeadObjectCommand({ Bucket: env().STORAGE_BUCKET, Key: objectKey }));
        return true;
      } catch {
        return false;
      }
    },
    async createSignedUrl(objectKey, ttlSeconds) {
      const { s3, presigner } = await load();
      const c = await makeClient();
      const getCmd = new s3.GetObjectCommand({ Bucket: env().STORAGE_BUCKET, Key: objectKey });
      return presigner.getSignedUrl(c, { expiresIn: ttlSeconds }) as Promise<string>;
    },
    async createSignedUpload(objectKey, ttlSeconds, contentType, maxBytes) {
      const { s3, presigner } = await load();
      const c = await makeClient();
      const putCmd = new s3.PutObjectCommand({
        Bucket: env().STORAGE_BUCKET,
        Key: objectKey,
        ContentType: contentType,
        ContentLength: maxBytes,
      });
      const uploadUrl = (await presigner.getSignedUrl(c, { expiresIn: ttlSeconds })) as string;
      return {
        uploadUrl,
        objectKey,
        fields: {},
        headers: { 'content-type': contentType },
        method: 'PUT' as const,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },
    async confirmUpload(objectKey) {
      const { s3 } = await load();
      const c = await makeClient();
      try {
        const head = await c.send(new s3.HeadObjectCommand({ Bucket: env().STORAGE_BUCKET, Key: objectKey }));
        return {
          sizeBytes: head.ContentLength ?? 0,
          contentType: head.ContentType ?? 'application/octet-stream',
        };
      } catch {
        return null;
      }
    },
  };
}

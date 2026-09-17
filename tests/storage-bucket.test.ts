import { describe, expect, it } from 'vitest';
import { resolveStorageBucketName } from '@/lib/firebase/admin';

describe('resolveStorageBucketName', () => {
  it('prefers the bucket from the Firebase web config', () => {
    // Projects created since the 2024 default-bucket change use this shape, and
    // deriving it from the project id would target a bucket that does not exist.
    expect(resolveStorageBucketName('keypad-prod', 'keypad-prod.firebasestorage.app')).toBe(
      'keypad-prod.firebasestorage.app',
    );
  });

  it('falls back to the legacy appspot name for older projects', () => {
    expect(resolveStorageBucketName('keypad-prod', undefined)).toBe('keypad-prod.appspot.com');
  });

  it('treats a blank configured bucket as unset', () => {
    expect(resolveStorageBucketName('keypad-prod', '   ')).toBe('keypad-prod.appspot.com');
  });

  it('returns undefined without a project id, so the SDK uses its own default', () => {
    expect(resolveStorageBucketName(undefined, undefined)).toBeUndefined();
  });
});

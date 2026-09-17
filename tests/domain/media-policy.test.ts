import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_BYTES, VOICE_MAX_BYTES } from '@mt/types';
import { extensionForMime, isWithinClientSizeLimit, sniffMimeType, storagePathFor, validateUpload } from '@/lib/domain/media-policy';
import { AppError } from '@/lib/domain/errors';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0xf2, 0x1e]);
const TEXT = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0x6f, 0x6e, 0x6c]);

describe('sniffMimeType', () => {
  it('identifies images and audio from their magic bytes', () => {
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(WEBM)).toBe('audio/webm');
  });

  it('rejects unknown content and files that are too short to identify', () => {
    expect(sniffMimeType(TEXT)).toBeNull();
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('refuses a video container even when the client calls it audio', () => {
    expect(sniffMimeType(WEBM, 'video/webm')).toBeNull();
  });
});

describe('validateUpload', () => {
  it('accepts an image whose bytes match an allowed type', () => {
    expect(validateUpload({ kind: 'image', declaredMime: 'image/jpeg', bytes: JPEG }).mimeType).toBe('image/jpeg');
  });

  it('ignores the declared type when it disagrees with the bytes', () => {
    expect(validateUpload({ kind: 'image', declaredMime: 'image/png', bytes: JPEG }).mimeType).toBe('image/jpeg');
  });

  it('throws UNSUPPORTED_MEDIA_TYPE for a script disguised as an image', () => {
    expect(() => validateUpload({ kind: 'image', declaredMime: 'image/png', bytes: TEXT })).toThrow(AppError);
  });

  it('throws when an image is sent as a voice message', () => {
    expect(() => validateUpload({ kind: 'voice', declaredMime: 'audio/webm', bytes: JPEG })).toThrow(AppError);
  });

  it('rejects an oversized payload', () => {
    const tooBig = new Uint8Array(IMAGE_MAX_BYTES + 1);
    tooBig.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(() => validateUpload({ kind: 'image', declaredMime: 'image/jpeg', bytes: tooBig })).toThrow(/too large/);
  });
});

describe('extensionForMime', () => {
  it('maps known types to safe extensions', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('audio/webm')).toBe('webm');
  });

  it('never derives an extension from client input', () => {
    expect(extensionForMime('image/svg+xml')).toBe('bin');
    expect(extensionForMime('../../etc/passwd')).toBe('bin');
  });
});

describe('storagePathFor', () => {
  it('namespaces by owner and conversation and uses the media id', () => {
    expect(
      storagePathFor({ ownerId: 'u1', conversationId: 'c1', mediaId: 'm1', mimeType: 'image/jpeg' }),
    ).toBe('media/u1/c1/m1.jpg');
    expect(
      storagePathFor({ ownerId: 'u1', conversationId: null, mediaId: 'm1', mimeType: 'audio/webm' }),
    ).toBe('media/u1/drafts/m1.webm');
  });
});

it('keeps the documented client size caps', () => {
  expect(isWithinClientSizeLimit('image', IMAGE_MAX_BYTES)).toBe(true);
  expect(isWithinClientSizeLimit('image', IMAGE_MAX_BYTES + 1)).toBe(false);
  expect(isWithinClientSizeLimit('voice', VOICE_MAX_BYTES + 1)).toBe(false);
});

import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VOICE_MIME_TYPES,
  IMAGE_MAX_BYTES,
  VOICE_MAX_BYTES,
  type MediaKind,
} from '@mt/types';
import { AppError } from './errors';

interface MagicSignature {
  mime: string;
  bytes: number[];
  /** Offset of the signature, needed for MP4 where the brand sits at byte 4. */
  offset?: number;
  /** Optional ASCII brand for container formats. */
  brand?: string;
}

const SIGNATURES: MagicSignature[] = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, brand: 'WEBP' },
  { mime: 'audio/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Sniffs the real content type from the first bytes of a file. The MIME type a
 * client declares is never trusted — it is only used to disambiguate containers
 * whose magic bytes are shared (MP4 audio vs video).
 */
export function sniffMimeType(bytes: Uint8Array, declaredMime?: string): string | null {
  if (bytes.length < 4) return null;
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (bytes.length < offset + signature.bytes.length) continue;
    if (!startsWith(bytes, signature.bytes, offset)) continue;
    if (signature.brand) {
      const brand = ascii(bytes, 8, 4);
      if (brand !== signature.brand) continue;
    }
    if (signature.mime === 'audio/mp4') {
      const brand = ascii(bytes, 8, 4);
      // M4A/M4B brands are audio; anything else is video and must be rejected.
      const audioBrands = ['M4A ', 'M4B ', 'mp4a', 'isom', 'dash'];
      if (!audioBrands.includes(brand) && declaredMime !== 'audio/mp4') return null;
    }
    if (signature.mime === 'audio/webm' && declaredMime === 'video/webm') return null;
    return signature.mime;
  }
  // Raw MP3 frames without an ID3 header.
  if (isMpegFrame(bytes)) return 'audio/mpeg';
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function isMpegFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0xff && (bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0) && bytes[1] !== 0xff
  );
}

export interface UploadValidation {
  mimeType: string;
  sizeBytes: number;
}

export function validateUpload(options: {
  kind: MediaKind;
  declaredMime: string;
  bytes: Uint8Array;
}): UploadValidation {
  const { kind, declaredMime, bytes } = options;
  const sniffed = sniffMimeType(bytes, declaredMime);
  if (!sniffed) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'unsupported or corrupted file');
  }
  const allowed = kind === 'image' ? ALLOWED_IMAGE_MIME_TYPES : ALLOWED_VOICE_MIME_TYPES;
  if (!(allowed as readonly string[]).includes(sniffed)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `${sniffed} is not allowed for ${kind} messages`);
  }
  const maxBytes = kind === 'image' ? IMAGE_MAX_BYTES : VOICE_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'file is too large', {
      context: { maxBytes, sizeBytes: bytes.byteLength },
    });
  }
  return { mimeType: sniffed, sizeBytes: bytes.byteLength };
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};

export function extensionForMime(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? 'bin';
}

/**
 * Storage layout. Files are namespaced by owner and conversation and named with
 * an unguessable id, so a leaked path from one conversation cannot be used to
 * enumerate another one. There is never a public URL for these objects.
 */
export function storagePathFor(options: {
  ownerId: string;
  conversationId: string | null;
  mediaId: string;
  mimeType: string;
}): string {
  const scope = options.conversationId ?? 'drafts';
  return `media/${options.ownerId}/${scope}/${options.mediaId}.${extensionForMime(options.mimeType)}`;
}

/**
 * Client side pre-upload size guard, mirroring the server rule so the user gets
 * feedback before burning bandwidth.
 */
export function isWithinClientSizeLimit(kind: MediaKind, sizeBytes: number): boolean {
  return sizeBytes <= (kind === 'image' ? IMAGE_MAX_BYTES : VOICE_MAX_BYTES);
}

import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE_PX } from '@mt/types';

export interface CompressedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Resizes and re-encodes a picked image in the browser before upload.
 *
 * Mobile cameras produce 4–12 MB JPEGs; on a phone network that is a failed
 * upload. Everything above `IMAGE_MAX_EDGE_PX` is scaled down and re-encoded,
 * with a quality loop that keeps the result under the server's byte limit.
 */
export async function compressImage(file: File, maxEdge = IMAGE_MAX_EDGE_PX): Promise<CompressedImage> {
  if (typeof createImageBitmap === 'undefined') {
    return { blob: file, mimeType: file.type || 'image/jpeg', width: 0, height: 0 };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return { blob: file, mimeType: file.type || 'image/jpeg', width, height };
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // GIFs keep their animation only if untouched; everything else becomes JPEG
  // unless it has an alpha channel, in which case WebP is smaller.
  const hasAlpha = file.type === 'image/png' || file.type === 'image/webp';
  const mimeType = file.type === 'image/gif' ? 'image/gif' : hasAlpha ? 'image/webp' : 'image/jpeg';

  for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45]) {
    const blob = await toBlob(canvas, mimeType, quality);
    if (blob && blob.size <= IMAGE_MAX_BYTES) {
      return { blob, mimeType, width, height };
    }
    if (!blob) break;
  }
  const fallback = await toBlob(canvas, mimeType, 0.4);
  if (!fallback) throw new Error('could not encode the image');
  return { blob: fallback, mimeType, width, height };
}

function toBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mimeType, quality));
}

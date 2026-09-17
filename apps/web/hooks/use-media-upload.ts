'use client';

import { useCallback, useRef, useState } from 'react';
import { compressImage } from '@/lib/browser/image-compress';
import { api } from '@/lib/client/api';
import { useUiStore } from '@/stores/ui-store';
import { errorMessage } from '@/stores/access-store';

export interface UploadProgress {
  mediaId: string | null;
  ratio: number;
  phase: 'idle' | 'compressing' | 'uploading' | 'done' | 'error';
  error: string | null;
}

/**
 * Image upload pipeline: compress → reserve an upload intent → POST the bytes
 * with progress → hand back the media id for `sendMedia`.
 */
export function useMediaUpload() {
  const [progress, setProgress] = useState<UploadProgress>({
    mediaId: null,
    ratio: 0,
    phase: 'idle',
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const uploadImage = useCallback(async (file: File): Promise<string | null> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ mediaId: null, ratio: 0, phase: 'compressing', error: null });
    try {
      const compressed = await compressImage(file);
      const intent = await api.media.createIntent({
        kind: 'image',
        mimeType: compressed.mimeType,
        sizeBytes: compressed.blob.size,
        width: compressed.width || undefined,
        height: compressed.height || undefined,
      });
      setProgress({ mediaId: intent.mediaId, ratio: 0.05, phase: 'uploading', error: null });
      await api.media.upload(
        intent.mediaId,
        compressed.blob,
        (ratio) => setProgress((current) => ({ ...current, ratio: 0.05 + ratio * 0.95 })),
        controller.signal,
      );
      setProgress({ mediaId: intent.mediaId, ratio: 1, phase: 'done', error: null });
      return intent.mediaId;
    } catch (error) {
      const message = errorMessage(error);
      setProgress({ mediaId: null, ratio: 0, phase: 'error', error: message });
      useUiStore.getState().pushToast(message, 'error');
      return null;
    } finally {
      abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setProgress({ mediaId: null, ratio: 0, phase: 'idle', error: null });
  }, []);

  const reset = useCallback(() => {
    setProgress({ mediaId: null, ratio: 0, phase: 'idle', error: null });
  }, []);

  return { progress, uploadImage, cancel, reset };
}

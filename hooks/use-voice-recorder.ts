'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { recordVoice, type RecorderHandle } from '@/lib/browser/media-recorder';
import { api } from '@/lib/client/api';
import { useUiStore } from '@/stores/ui-store';
import { errorMessage } from '@/stores/access-store';

export type RecorderPhase = 'idle' | 'recording' | 'review' | 'uploading';

export interface VoiceRecorderApi {
  phase: RecorderPhase;
  durationMs: number;
  level: number;
  previewUrl: string | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
  /** Uploads the recorded blob and returns the media id. */
  send: () => Promise<string | null>;
  discard: () => void;
}

/**
 * Microphone recording with a live level meter and an optional review step, then
 * upload through the same media pipeline as images.
 */
export function useVoiceRecorder(): VoiceRecorderApi {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<RecorderHandle | null>(null);
  const recordingRef = useRef<{ blob: Blob; mimeType: string; durationMs: number } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const { handle, done } = await recordVoice({
        onLevel: (value) => setLevel(value),
      });
      handleRef.current = handle;
      setPhase('recording');
      setDurationMs(0);
      timerRef.current = window.setInterval(() => setDurationMs((value) => value + 100), 100);
      done
        .then((recording) => {
          recordingRef.current = recording;
          setPreviewUrl(URL.createObjectURL(recording.blob));
          setPhase('review');
        })
        .catch((cause: unknown) => {
          if (errorMessage(cause) !== 'cancelled') {
            setError(errorMessage(cause));
            useUiStore.getState().pushToast(errorMessage(cause), 'error');
          }
          setPhase('idle');
        })
        .finally(() => {
          if (timerRef.current !== null) clearInterval(timerRef.current);
          setLevel(0);
        });
    } catch (cause) {
      setError(errorMessage(cause));
      useUiStore.getState().pushToast(errorMessage(cause), 'error');
      setPhase('idle');
    }
  }, []);

  const stop = useCallback(async () => {
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase('idle');
    setDurationMs(0);
  }, []);

  const discard = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    recordingRef.current = null;
    setPhase('idle');
    setDurationMs(0);
  }, [previewUrl]);

  const send = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return null;
    setPhase('uploading');
    try {
      const intent = await api.media.createIntent({
        kind: 'voice',
        mimeType: recording.mimeType,
        sizeBytes: recording.blob.size,
        durationMs: Math.round(recording.durationMs),
      });
      await api.media.upload(intent.mediaId, recording.blob);
      discard();
      return intent.mediaId;
    } catch (cause) {
      setError(errorMessage(cause));
      useUiStore.getState().pushToast(errorMessage(cause), 'error');
      setPhase('review');
      return null;
    }
  }, [discard]);

  return { phase, durationMs, level, previewUrl, error, start, stop, cancel, send, discard };
}

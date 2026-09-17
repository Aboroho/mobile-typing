import { VOICE_MAX_DURATION_MS, VOICE_MIN_DURATION_MS } from '@mt/types';

export interface VoiceRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface RecorderHandle {
  stop: () => void;
  cancel: () => void;
  /** Emits an approximate amplitude in 0..1 for the level meter. */
  onLevel?: (level: number) => void;
}

const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/**
 * Records microphone audio with MediaRecorder. Resolves with the encoded blob and
 * its duration; rejects on permission errors and on recordings that are too
 * short to be worth sending.
 */
export async function recordVoice(options: {
  onLevel?: (level: number) => void;
  maxDurationMs?: number;
}): Promise<{ handle: RecorderHandle; done: Promise<VoiceRecording> }> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('voice recording is not supported in this browser');
  }
  const mimeType = pickSupportedMimeType();
  if (!mimeType) throw new Error('no supported audio format for recording');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  const startedAt = Date.now();
  let cancelled = false;
  let analyserFrame = 0;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const done = new Promise<VoiceRecording>((resolve, reject) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      cancelAnimationFrame(analyserFrame);
      const durationMs = Date.now() - startedAt;
      if (cancelled) {
        reject(new Error('cancelled'));
        return;
      }
      if (durationMs < VOICE_MIN_DURATION_MS) {
        reject(new Error('recording is too short'));
        return;
      }
      resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType, durationMs });
    };
    recorder.onerror = () => {
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error('recording failed'));
    };
  });

  recorder.start(250);

  // Level meter: cheap AnalyserNode sampling so the UI can show activity.
  if (options.onLevel && typeof AudioContext !== 'undefined') {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128) / 128);
      options.onLevel?.(Math.min(1, peak * 2));
      analyserFrame = requestAnimationFrame(tick);
    };
    tick();
    void context.resume().catch(() => undefined);
  }

  const maxDuration = options.maxDurationMs ?? VOICE_MAX_DURATION_MS;
  const timer = setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, maxDuration);

  const handle: RecorderHandle = {
    stop: () => {
      clearTimeout(timer);
      if (recorder.state !== 'inactive') recorder.stop();
    },
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      if (recorder.state !== 'inactive') recorder.stop();
    },
    onLevel: options.onLevel,
  };

  return { handle, done };
}

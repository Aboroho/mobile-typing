'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { MediaView } from '@mt/types';
import { formatDuration } from '@mt/utils';
import { cn } from '@/components/ui/cn';

/**
 * Voice message player with play/pause, scrubbing and progress. The audio element
 * is created on demand and released on unmount.
 */
export function VoiceMessage({ media }: { media: MediaView }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const durationMs = media.durationMs ?? 0;

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  if (media.deleted) {
    return <p className="rounded-xl bg-surface-sunken px-3 py-2 text-xs text-ink-muted">Voice message deleted</p>;
  }

  const toggle = () => {
    if (!audioRef.current && media.contentUrl) {
      const audio = new Audio(media.contentUrl);
      audio.preload = 'metadata';
      audio.onended = () => {
        setPlaying(false);
        setPositionMs(0);
      };
      audio.ontimeupdate = () => setPositionMs(audio.currentTime * 1000);
      audioRef.current = audio;
    }
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  return (
    <div className="flex min-w-[12rem] items-center gap-3">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <div className="flex-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-ink-faint tabular-nums">
          <span>{formatDuration(positionMs)}</span>
          <span>{formatDuration(durationMs)}</span>
        </div>
      </div>
    </div>
  );
}

export function VoiceLevelMeter({ level, durationMs }: { level: number; durationMs: number }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className={cn('h-3 w-3 rounded-full bg-danger transition-transform', level > 0.05 && 'scale-125')}
      />
      <span className="font-mono text-sm tabular-nums text-ink">{formatDuration(durationMs)}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
        <span className="block h-full rounded-full bg-danger" style={{ width: `${Math.round(level * 100)}%` }} />
      </span>
    </div>
  );
}

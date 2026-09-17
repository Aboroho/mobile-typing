'use client';

export interface StatsBarProps {
  remainingMs: number;
  wordsPerMinute: number;
  accuracy: number;
  correctWords: number;
  incorrectWords: number;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="font-mono text-lg font-semibold text-ink tabular-nums">{value}</span>
      <span className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</span>
    </div>
  );
}

export function StatsBar({ remainingMs, wordsPerMinute, accuracy, correctWords, incorrectWords }: StatsBarProps) {
  const seconds = Math.ceil(remainingMs / 1000);
  return (
    <div className="grid grid-cols-5 items-center gap-1 rounded-2xl border border-line bg-surface-raised px-2 py-3">
      <Stat label="time" value={`${seconds}s`} />
      <Stat label="wpm" value={wordsPerMinute.toFixed(0)} />
      <Stat label="accuracy" value={`${Math.round(accuracy * 100)}%`} />
      <Stat label="correct" value={String(correctWords)} />
      <Stat label="errors" value={String(incorrectWords)} />
    </div>
  );
}

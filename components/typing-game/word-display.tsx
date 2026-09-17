'use client';

import type { CharacterState } from '@mt/domain';
import { cn } from '@/components/ui/cn';

/** Renders the target word with per-character correct/incorrect highlighting. */
export function WordDisplay({ chars, extra }: { chars: CharacterState[]; extra: number }) {
  return (
    <p
      aria-live="polite"
      data-testid="target-word"
      className="flex flex-wrap items-center justify-center gap-x-1 gap-y-2 font-mono text-3xl font-semibold tracking-wide sm:text-4xl"
    >
      {chars.map((state, index) => (
        <span
          key={`${index}-${state.char}`}
          className={cn(
            'rounded px-0.5 transition-colors',
            state.state === 'pending' && 'text-ink-faint',
            state.state === 'correct' && 'text-success',
            state.state === 'incorrect' && 'bg-danger/15 text-danger underline decoration-danger',
          )}
        >
          {state.char}
        </span>
      ))}
      {extra > 0 ? (
        <span aria-hidden className="text-danger">
          {'•'.repeat(Math.min(extra, 6))}
        </span>
      ) : null}
    </p>
  );
}

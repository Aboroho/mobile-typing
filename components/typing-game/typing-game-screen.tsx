'use client';

import { useEffect, useRef } from 'react';
import { Keyboard, Languages, Loader2, Timer } from 'lucide-react';
import { TYPING_DURATIONS_SECONDS, type TypingDurationSeconds, type TypingLanguage } from '@mt/types';
import { useTypingGame } from '@/hooks/use-typing-game';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { WordDisplay } from './word-display';
import { StatsBar } from './stats-bar';
import { ResultCard } from './result-card';

const LANGUAGE_OPTIONS: { value: TypingLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'বাংলা' },
];

/**
 * The public face of the product. Nothing in this component hints at anything
 * but a typing test; the secret-code listener lives one level up.
 *
 * Layout is mobile-first (`max-w-lg` on phones) and expands to a comfortable
 * reading width on tablet/desktop (`md:max-w-2xl`, `lg:max-w-3xl`).
 */
export function TypingGameScreen() {
  const game = useTypingGame();
  const inputRef = useRef<HTMLInputElement>(null);

  // Mobile keyboards only appear when an editable field has focus.
  useEffect(() => {
    if (game.phase === 'running') inputRef.current?.focus();
  }, [game.phase, game.wordIndex]);

  const canStart = !game.loading || game.words.length > 0;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-4 px-4 py-6 sm:px-6 md:max-w-2xl md:py-10 lg:max-w-3xl">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded-xl bg-brand-soft p-2 text-brand-strong">
            <Keyboard className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight md:text-lg">Keypad</h1>
            <p className="text-xs text-ink-muted">Typing practice</p>
          </div>
        </div>
        <span className="rounded-full bg-surface-sunken px-2 py-1 text-[10px] uppercase tracking-wider text-ink-faint">
          {game.language === 'bn' ? 'বাংলা' : 'English'}
        </span>
      </header>

      {game.phase === 'setup' ? (
        <Card className="animate-fade-in">
          <CardHeader>
            <CardTitle>Choose your test</CardTitle>
            <CardDescription>Type as many words as you can before the timer runs out.</CardDescription>
          </CardHeader>
          <div className="space-y-4">
            <div>
              <span className="mb-1 block text-xs font-medium text-ink-muted">
                <Languages className="mr-1 inline h-3.5 w-3.5" />
                Language
              </span>
              <SegmentedControl
                label="Language"
                options={LANGUAGE_OPTIONS}
                value={game.language}
                onChange={(value) => game.setLanguage(value)}
              />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-ink-muted">
                <Timer className="mr-1 inline h-3.5 w-3.5" />
                Duration
              </span>
              <SegmentedControl
                label="Duration"
                options={TYPING_DURATIONS_SECONDS.map((value) => ({
                  value: value as TypingDurationSeconds,
                  label: `${value}s`,
                }))}
                value={game.durationSeconds}
                onChange={(value) => game.setDuration(value)}
              />
            </div>
            {game.wordListError ? (
              <p role="alert" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                {game.wordListError}
              </p>
            ) : null}
            <Button
              className="w-full"
              size="lg"
              onClick={game.start}
              disabled={!canStart}
              aria-busy={game.loading && game.words.length === 0}
            >
              {game.loading && game.words.length === 0 ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading words…
                </>
              ) : (
                'Start test'
              )}
            </Button>
          </div>
        </Card>
      ) : null}

      {game.phase === 'running' ? (
        <div className="flex flex-col gap-4">
          <StatsBar
            remainingMs={game.remainingMs}
            wordsPerMinute={game.wordsPerMinute}
            accuracy={game.accuracy}
            correctWords={game.correctWords}
            incorrectWords={game.incorrectWords}
          />
          <div className="flex min-h-[9rem] flex-col items-center justify-center gap-6 rounded-2xl border border-line bg-surface-raised px-4 py-8 md:min-h-[12rem] md:px-8">
            <WordDisplay chars={game.charStates} extra={game.typed.length - game.currentWord.length} />
            <input
              ref={inputRef}
              value={game.typed}
              onChange={(event) => game.handleInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter advances like Space so desktop keyboards feel natural.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  game.handleInput(`${game.typed} `);
                }
              }}
              aria-label="Type the word shown above"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="next"
              className="w-full max-w-md rounded-xl border border-line bg-surface px-3 py-2 text-center font-mono text-lg outline-none focus:border-brand md:py-3 md:text-xl"
            />
          </div>
          <div className="flex items-center justify-between text-xs text-ink-faint">
            <span>
              Word {game.wordIndex + 1} of {game.words.length}
            </span>
            <button type="button" onClick={game.finish} className="text-ink-muted underline-offset-4 hover:underline">
              Finish early
            </button>
          </div>
        </div>
      ) : null}

      {game.phase === 'finished' && game.result ? (
        <ResultCard result={game.result} onReplay={game.replay} />
      ) : null}

      <footer className="mt-auto pt-4 text-center text-[11px] text-ink-faint">
        Practice English and Bengali typing. No account needed.
      </footer>
    </main>
  );
}

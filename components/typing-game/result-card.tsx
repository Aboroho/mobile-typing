'use client';

import { RotateCcw, Trophy } from 'lucide-react';
import type { TypingResult } from '@mt/types';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ResultCard({ result, onReplay }: { result: TypingResult; onReplay: () => void }) {
  const grade =
    result.wordsPerMinute >= 60 ? 'Excellent' : result.wordsPerMinute >= 35 ? 'Good' : 'Keep practising';
  return (
    <Card className="animate-slide-up">
      <CardHeader className="items-center text-center">
        <span className="rounded-full bg-brand-soft p-3 text-brand-strong">
          <Trophy className="h-6 w-6" />
        </span>
        <CardTitle>Test complete</CardTitle>
        <CardDescription>{grade} — here is how you did.</CardDescription>
      </CardHeader>
      <dl className="grid grid-cols-2 gap-3 text-center">
        <Metric label="Words per minute" value={result.wordsPerMinute.toFixed(1)} />
        <Metric label="Accuracy" value={`${Math.round(result.accuracy * 100)}%`} />
        <Metric label="Correct words" value={String(result.correctWords)} />
        <Metric label="Errors" value={String(result.incorrectWords)} />
      </dl>
      <Button className="mt-4 w-full" size="lg" onClick={onReplay}>
        <RotateCcw className="h-4 w-4" />
        Play again
      </Button>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-sunken px-3 py-3">
      <dt className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="font-mono text-2xl font-semibold text-ink tabular-nums">{value}</dd>
    </div>
  );
}

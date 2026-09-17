import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeTypingResult,
  diffWord,
  pickWords,
} from '@mt/domain';
import type { TypingDurationSeconds, TypingLanguage, TypingResult, TypingWordAttempt } from '@mt/types';
import { api } from '@/lib/client/api';

const WORDS_PER_SESSION = 60;

export type GamePhase = 'setup' | 'running' | 'finished';

export interface TypingGameApi {
  phase: GamePhase;
  language: TypingLanguage;
  durationSeconds: TypingDurationSeconds;
  words: string[];
  wordIndex: number;
  currentWord: string;
  typed: string;
  charStates: ReturnType<typeof diffWord>['chars'];
  correctWords: number;
  incorrectWords: number;
  wordsPerMinute: number;
  accuracy: number;
  remainingMs: number;
  result: TypingResult | null;
  wordListError: string | null;
  setLanguage: (language: TypingLanguage) => void;
  setDuration: (duration: TypingDurationSeconds) => void;
  start: () => void;
  handleInput: (value: string) => void;
  finish: () => void;
  replay: () => void;
}

/**
 * Typing-practice game engine.
 *
 * Pure client-side scoring with an injectable word source; the finished result
 * is posted to `/api/v1/typing/sessions` (best effort — the game works fully
 * offline). The secret-code detector runs independently of this hook.
 */
export function useTypingGame(): TypingGameApi {
  const [language, setLanguage] = useState<TypingLanguage>('en');
  const [durationSeconds, setDuration] = useState<TypingDurationSeconds>(30);
  const [phase, setPhase] = useState<GamePhase>('setup');
  const [words, setWords] = useState<string[]>([]);
  const [wordIndex, setWordIndex] = useState(0);
  const [typed, setTyped] = useState('');
  const [attempts, setAttempts] = useState<TypingWordAttempt[]>([]);
  const [keystrokes, setKeystrokes] = useState({ total: 0, correct: 0 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(30_000);
  const [result, setResult] = useState<TypingResult | null>(null);
  const [wordListError, setWordListError] = useState<string | null>(null);

  const wordStartedAt = useRef<number>(0);

  const loadWords = useCallback(async (lang: TypingLanguage) => {
    setWordListError(null);
    try {
      const response = await fetch(`/typing-words/${lang}.txt`, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`word list unavailable (${response.status})`);
      const text = await response.text();
      const list = text
        .split('\n')
        .map((word) => word.trim())
        .filter(Boolean);
      if (list.length === 0) throw new Error('word list is empty');
      setWords(pickWords(list, WORDS_PER_SESSION));
    } catch (error) {
      setWordListError(error instanceof Error ? error.message : 'could not load the word list');
    }
  }, []);

  useEffect(() => {
    void loadWords(language);
  }, [language, loadWords]);

  // Countdown: the game ends on its own, which is what makes the score real.
  useEffect(() => {
    if (phase !== 'running' || startedAt === null) return;
    const deadline = startedAt + durationSeconds * 1000;
    const tick = () => {
      const left = deadline - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) finish();
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
    // `finish` is stable enough for this effect: it only reads refs/state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, startedAt, durationSeconds]);

  const start = useCallback(() => {
    if (words.length === 0) return;
    setAttempts([]);
    setKeystrokes({ total: 0, correct: 0 });
    setWordIndex(0);
    setTyped('');
    setResult(null);
    setStartedAt(Date.now());
    setRemainingMs(durationSeconds * 1000);
    wordStartedAt.current = Date.now();
    setPhase('running');
  }, [words.length, durationSeconds]);

  const finish = useCallback(() => {
    setPhase((current) => {
      if (current !== 'running') return current;
      const typingResult = computeTypingResult({
        language,
        durationSeconds,
        attempts,
        totalKeystrokes: keystrokes.total,
        correctKeystrokes: keystrokes.correct,
        elapsedMs: startedAt ? Date.now() - startedAt : 0,
      });
      setResult(typingResult);
      void api.typing
        .submit({ result: typingResult, attempts: attempts.slice(-200) })
        .catch(() => undefined);
      return 'finished';
    });
  }, [language, durationSeconds, attempts, keystrokes, startedAt]);

  const handleInput = useCallback(
    (value: string) => {
      if (phase !== 'running') return;
      const target = words[wordIndex] ?? '';
      setTyped(value);
      setKeystrokes((current) => {
        const total = current.total + 1;
        const lastIndex = value.length - 1;
        const correct = current.correct + (value[lastIndex] === target[lastIndex] ? 1 : 0);
        return { total, correct };
      });

      if (value === target) {
        setAttempts((current) => [
          ...current,
          {
            word: target,
            typed: value,
            correct: true,
            durationMs: Date.now() - wordStartedAt.current,
          },
        ]);
        setWordIndex((index) => (index + 1) % words.length);
        setTyped('');
        wordStartedAt.current = Date.now();
        return;
      }
      // Space commits an incorrect attempt and moves on, like most typing tests.
      if (value.endsWith(' ')) {
        setAttempts((current) => [
          ...current,
          {
            word: target,
            typed: value.trimEnd(),
            correct: false,
            durationMs: Date.now() - wordStartedAt.current,
          },
        ]);
        setWordIndex((index) => (index + 1) % words.length);
        setTyped('');
        wordStartedAt.current = Date.now();
      }
    },
    [phase, words, wordIndex],
  );

  const replay = useCallback(() => {
    setPhase('setup');
    setResult(null);
    void loadWords(language);
  }, [language, loadWords]);

  const currentWord = words[wordIndex] ?? '';
  const liveResult = useMemo(
    () =>
      computeTypingResult({
        language,
        durationSeconds,
        attempts,
        totalKeystrokes: keystrokes.total,
        correctKeystrokes: keystrokes.correct,
        elapsedMs: startedAt ? Date.now() - startedAt : 0,
      }),
    [language, durationSeconds, attempts, keystrokes, startedAt],
  );

  return {
    phase,
    language,
    durationSeconds,
    words,
    wordIndex,
    currentWord,
    typed,
    charStates: diffWord(currentWord, typed).chars,
    correctWords: liveResult.correctWords,
    incorrectWords: liveResult.incorrectWords,
    wordsPerMinute: liveResult.wordsPerMinute,
    accuracy: liveResult.accuracy,
    remainingMs,
    result,
    wordListError,
    setLanguage,
    setDuration,
    start,
    handleInput,
    finish,
    replay,
  };
}

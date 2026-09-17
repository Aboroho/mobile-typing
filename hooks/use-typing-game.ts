import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeTypingResult,
  diffWord,
  pickWords,
} from '@mt/domain';
import type { TypingDurationSeconds, TypingLanguage, TypingResult, TypingWordAttempt } from '@mt/types';
import { api } from '@/lib/client/api';

const WORDS_PER_SESSION = 60;

/** Built-in fallback so the game still starts if the static word list fails to load. */
const FALLBACK_WORDS_EN: readonly string[] = [
  'the', 'and', 'you', 'that', 'with', 'have', 'this', 'from', 'they', 'will',
  'your', 'what', 'when', 'make', 'like', 'time', 'just', 'know', 'take', 'people',
  'into', 'year', 'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then',
  'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after',
  'work', 'first', 'well', 'even', 'want', 'because', 'these', 'give', 'most', 'us',
];

const FALLBACK_WORDS_BN: readonly string[] = [
  'আমি', 'তুমি', 'সে', 'আমরা', 'তারা', 'এবং', 'কিন্তু', 'যদি', 'তাহলে', 'করে',
  'হয়', 'ছিল', 'আছে', 'নেই', 'ভালো', 'খারাপ', 'দিন', 'রাত', 'বাড়ি', 'স্কুল',
  'বই', 'পানি', 'খাবার', 'বন্ধু', 'পরিবার', 'মা', 'বাবা', 'ভাই', 'বোন', 'শহর',
  'গ্রাম', 'পথ', 'গাড়ি', 'বাংলা', 'ইংরেজি', 'সময়', 'কাজ', 'খেলা', 'গান', 'কথা',
  'লিখা', 'পড়া', 'দেখা', 'শোনা', 'যাওয়া', 'আসা', 'থাকা', 'করা', 'বলা', 'চাওয়া',
];

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
  loading: boolean;
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
 *
 * The Start button stays disabled only while words are loading. If the remote
 * word list fails, a built-in fallback list is used so the button always works.
 */
export function useTypingGame(): TypingGameApi {
  const [language, setLanguageState] = useState<TypingLanguage>('en');
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
  const [loading, setLoading] = useState(true);

  const wordStartedAt = useRef<number>(0);
  const finishRef = useRef<() => void>(() => undefined);
  const wordsRef = useRef<string[]>([]);

  const phaseRef = useRef<GamePhase>('setup');
  phaseRef.current = phase;

  const applyWordList = useCallback((list: string[], warning: string | null = null) => {
    // Do not clobber an in-progress or finished run if a late fetch resolves.
    if (phaseRef.current !== 'setup') {
      setLoading(false);
      return;
    }
    const picked = pickWords(list, WORDS_PER_SESSION);
    wordsRef.current = picked;
    setWords(picked);
    setWordListError(warning);
    setLoading(false);
  }, []);

  const loadWords = useCallback(
    async (lang: TypingLanguage) => {
      setLoading(true);
      setWordListError(null);
      const fallback = lang === 'bn' ? FALLBACK_WORDS_BN : FALLBACK_WORDS_EN;
      try {
        const response = await fetch(`/typing-words/${lang}.txt`, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`word list unavailable (${response.status})`);
        const text = await response.text();
        const list = text
          .split('\n')
          .map((word) => word.trim())
          .filter(Boolean);
        if (list.length === 0) throw new Error('word list is empty');
        applyWordList(list);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'could not load the word list';
        // Still startable: fall back to the built-in list so Start is never stuck.
        applyWordList([...fallback], `${message}. Using built-in words instead.`);
      }
    },
    [applyWordList],
  );

  useEffect(() => {
    void loadWords(language);
  }, [language, loadWords]);

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

  finishRef.current = finish;

  // Countdown: the game ends on its own, which is what makes the score real.
  useEffect(() => {
    if (phase !== 'running' || startedAt === null) return;
    const deadline = startedAt + durationSeconds * 1000;
    const tick = () => {
      const left = deadline - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) finishRef.current();
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [phase, startedAt, durationSeconds]);

  const start = useCallback(() => {
    const pool = wordsRef.current.length > 0 ? wordsRef.current : words;
    if (pool.length === 0) {
      // Last-resort: seed fallback immediately so Start always does something.
      const fallback = language === 'bn' ? FALLBACK_WORDS_BN : FALLBACK_WORDS_EN;
      const picked = pickWords([...fallback], WORDS_PER_SESSION);
      wordsRef.current = picked;
      setWords(picked);
      setAttempts([]);
      setKeystrokes({ total: 0, correct: 0 });
      setWordIndex(0);
      setTyped('');
      setResult(null);
      setStartedAt(Date.now());
      setRemainingMs(durationSeconds * 1000);
      wordStartedAt.current = Date.now();
      setPhase('running');
      return;
    }
    setAttempts([]);
    setKeystrokes({ total: 0, correct: 0 });
    setWordIndex(0);
    setTyped('');
    setResult(null);
    setStartedAt(Date.now());
    setRemainingMs(durationSeconds * 1000);
    wordStartedAt.current = Date.now();
    setPhase('running');
  }, [words, durationSeconds, language]);

  const commitWord = useCallback(
    (target: string, typedValue: string, correct: boolean) => {
      setAttempts((current) => [
        ...current,
        {
          word: target,
          typed: typedValue,
          correct,
          durationMs: Date.now() - wordStartedAt.current,
        },
      ]);
      setWordIndex((index) => {
        const total = wordsRef.current.length || words.length || 1;
        return (index + 1) % total;
      });
      setTyped('');
      wordStartedAt.current = Date.now();
    },
    [words.length],
  );

  const handleInput = useCallback(
    (value: string) => {
      if (phase !== 'running') return;
      const target = (wordsRef.current[wordIndex] ?? words[wordIndex] ?? '');
      // Strip a trailing newline if Enter produced one (some mobile IMEs).
      const normalized = value.replace(/\r?\n/g, ' ');
      setTyped(normalized);
      setKeystrokes((current) => {
        const total = current.total + 1;
        const lastIndex = normalized.length - 1;
        const correct = current.correct + (normalized[lastIndex] === target[lastIndex] ? 1 : 0);
        return { total, correct };
      });

      if (normalized === target) {
        commitWord(target, normalized, true);
        return;
      }
      // Space (or Enter-as-space) commits an incorrect attempt and moves on.
      if (normalized.endsWith(' ')) {
        commitWord(target, normalized.trimEnd(), false);
      }
    },
    [phase, words, wordIndex, commitWord],
  );

  const setLanguage = useCallback((next: TypingLanguage) => {
    setLanguageState(next);
  }, []);

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
    loading,
    setLanguage,
    setDuration,
    start,
    handleInput,
    finish,
    replay,
  };
}

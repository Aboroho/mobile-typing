import {
  createKeystrokeBuffer,
  pushKeystroke,
  resetKeystrokeBuffer,
  type KeystrokeBuffer,
} from '@mt/domain';

export interface KeystrokeDetectorOptions {
  code: string;
  maxLength: number;
  caseSensitive: boolean;
  onMatch: (code: string) => void;
  /** Fields whose keystrokes must never reach the buffer. */
  ignoreSelector?: string;
}

/**
 * Credential and identity fields are excluded from the rolling buffer: typing a
 * password or an email address must never contribute to an unlock, and the
 * buffer must not silently collect secrets.
 */
const DEFAULT_IGNORE_SELECTOR = [
  'input[type="password"]',
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  '[data-secret-ignore="true"]',
].join(', ');

const DUPLICATE_WINDOW_MS = 120;

/**
 * Attaches the rolling secret-code buffer to the window.
 *
 * Both `keydown` (physical keyboards, works even with no focused field) and
 * `beforeinput` (mobile virtual keyboards, where `keydown.key` is often
 * "Unidentified") are used, with a short duplicate window so a desktop keystroke
 * is only counted once.
 */
export function attachKeystrokeDetector(options: KeystrokeDetectorOptions): {
  reset: () => void;
  detach: () => void;
} {
  const buffer: KeystrokeBuffer = createKeystrokeBuffer(options.maxLength);
  const ignoreSelector = options.ignoreSelector ?? DEFAULT_IGNORE_SELECTOR;
  const code = options.caseSensitive ? options.code : options.code.toLowerCase();
  let matched = false;
  let lastHandled = { key: '', at: 0 };

  const feed = (key: string): void => {
    if (matched || key.length !== 1) return;
    const now = Date.now();
    if (lastHandled.key === key && now - lastHandled.at < DUPLICATE_WINDOW_MS) return;
    lastHandled = { key, at: now };

    const normalized = options.caseSensitive ? key : key.toLowerCase();
    const result = pushKeystroke(buffer, normalized, code);
    if (result.matched && result.code) {
      matched = true;
      options.onMatch(result.code);
    }
  };

  const isIgnored = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return Boolean(element?.closest?.(ignoreSelector));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Dead' || event.isComposing) return;
    if (isIgnored(event.target)) return;
    feed(event.key);
  };

  const onBeforeInput = (event: InputEvent) => {
    if (event.inputType !== 'insertText' || !event.data) return;
    if (isIgnored(event.target)) return;
    feed(event.data);
  };

  globalThis.addEventListener('keydown', onKeyDown, { capture: true });
  globalThis.addEventListener('beforeinput', onBeforeInput, { capture: true });

  return {
    reset() {
      matched = false;
      lastHandled = { key: '', at: 0 };
      resetKeystrokeBuffer(buffer);
    },
    detach() {
      globalThis.removeEventListener('keydown', onKeyDown, { capture: true });
      globalThis.removeEventListener('beforeinput', onBeforeInput, { capture: true });
    },
  };
}

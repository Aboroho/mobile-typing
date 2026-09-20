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
 * "Unidentified" or missing entirely) are used. One physical keystroke on a
 * desktop keyboard fires *both* events, so a `beforeinput` that repeats a
 * `keydown` character within a short window is treated as the same keystroke
 * and counted once. Two `beforeinput` events are never deduplicated against
 * each other: on a mobile virtual keyboard each tap produces exactly one of
 * them, so two quick taps of the same key are two distinct characters and
 * dropping either one breaks codes with repeated letters.
 */
export function attachKeystrokeDetector(options: KeystrokeDetectorOptions): {
  reset: () => void;
  detach: () => void;
} {
  const buffer: KeystrokeBuffer = createKeystrokeBuffer(options.maxLength);
  const ignoreSelector = options.ignoreSelector ?? DEFAULT_IGNORE_SELECTOR;
  const code = options.caseSensitive ? options.code : options.code.toLowerCase();
  let matched = false;
  // The last character accepted from a `keydown`, so the matching `beforeinput`
  // of the same physical keystroke can be recognised and skipped.
  let keydownSeen: { key: string; at: number } | null = null;

  const feed = (key: string): boolean => {
    if (matched || key.length !== 1) return false;
    const normalized = options.caseSensitive ? key : key.toLowerCase();
    const result = pushKeystroke(buffer, normalized, code);
    if (result.matched && result.code) {
      matched = true;
      options.onMatch(result.code);
    }
    return true;
  };

  const isIgnored = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return Boolean(element?.closest?.(ignoreSelector));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Dead' || event.isComposing) return;
    if (isIgnored(event.target)) return;
    if (feed(event.key)) {
      keydownSeen = { key: event.key.toLowerCase(), at: Date.now() };
    }
  };

  const onBeforeInput = (event: InputEvent) => {
    if (event.inputType !== 'insertText' || !event.data) return;
    if (isIgnored(event.target)) return;
    const now = Date.now();
    // `data` can carry several characters at once (suggestion-bar commits on
    // some mobile keyboards): feed them one by one so the rolling buffer can
    // still complete the code.
    for (let index = 0; index < event.data.length; index += 1) {
      const char = event.data.charAt(index);
      if (
        index === 0 &&
        keydownSeen &&
        keydownSeen.key === char.toLowerCase() &&
        now - keydownSeen.at < DUPLICATE_WINDOW_MS
      ) {
        // Same physical keystroke already counted from its `keydown`.
        keydownSeen = null;
        continue;
      }
      keydownSeen = null;
      feed(char);
    }
  };

  globalThis.addEventListener('keydown', onKeyDown, { capture: true });
  globalThis.addEventListener('beforeinput', onBeforeInput, { capture: true });

  return {
    reset() {
      matched = false;
      keydownSeen = null;
      resetKeystrokeBuffer(buffer);
    },
    detach() {
      globalThis.removeEventListener('keydown', onKeyDown, { capture: true });
      globalThis.removeEventListener('beforeinput', onBeforeInput, { capture: true });
    },
  };
}

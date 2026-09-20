/**
 * Regression tests for unlocking on mobile devices.
 *
 * Mobile virtual keyboards do not produce usable `keydown` events: iOS Safari
 * fires none at all, Android reports `key: "Unidentified"`. The only reliable
 * per-character signal is `beforeinput` with `inputType: "insertText"`. These
 * tests drive the detector with exactly the event sequences real devices
 * produce, so the unlock flow cannot regress to desktop-only again.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { attachKeystrokeDetector } from '@/lib/browser/keystroke-detector';

type Listener = (event: unknown) => void;

const listeners = new Map<string, Listener[]>();

beforeEach(() => {
  listeners.clear();
  vi.stubGlobal('addEventListener', (type: string, fn: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  });
  vi.stubGlobal('removeEventListener', (type: string, fn: Listener) => {
    listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
  });
});

afterEach(() => vi.unstubAllGlobals());

function dispatch(type: string, event: unknown) {
  for (const fn of listeners.get(type) ?? []) fn(event);
}

function keydown(key: string) {
  dispatch('keydown', {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    target: null,
  });
}

function insertText(data: string) {
  dispatch('beforeinput', { inputType: 'insertText', data, target: null });
}

/** iOS Safari: no keydown events from the virtual keyboard at all. */
function iosType(text: string) {
  for (const char of text) insertText(char);
}

/** Android Chrome: keydown fires but with `key: "Unidentified"`. */
function androidType(text: string) {
  for (const char of text) {
    keydown('Unidentified');
    insertText(char);
  }
}

/** Desktop: one keydown + one beforeinput per physical keystroke. */
function desktopType(text: string) {
  for (const char of text) {
    keydown(char);
    insertText(char);
  }
}

function detectorFor(code: string, onMatch: (code: string) => void) {
  return attachKeystrokeDetector({ code, maxLength: 15, caseSensitive: true, onMatch });
}

describe('keystroke detector — mobile virtual keyboards', () => {
  it('unlocks from pure beforeinput events (iOS)', () => {
    const onMatch = vi.fn();
    const detector = detectorFor('opensesame', onMatch);
    iosType('the quick ');
    iosType('opensesame');
    expect(onMatch).toHaveBeenCalledWith('opensesame');
    detector.detach();
  });

  it('unlocks when Android fires Unidentified keydowns alongside', () => {
    const onMatch = vi.fn();
    const detector = detectorFor('opensesame', onMatch);
    androidType('opensesame');
    expect(onMatch).toHaveBeenCalledWith('opensesame');
    detector.detach();
  });

  it('keeps every quick tap of the same key (codes with doubled letters)', () => {
    // Two taps of the same key can easily land within 120 ms of each other.
    // They are two distinct characters and must never be deduplicated away —
    // this used to drop the second one, so codes like "hello" never matched.
    const onMatch = vi.fn();
    const detector = detectorFor('hello', onMatch);
    iosType('hello');
    expect(onMatch).toHaveBeenCalledWith('hello');
    detector.detach();
  });

  it('feeds a multi-character insertText commit character by character', () => {
    // Some keyboards commit a whole suggestion in a single insertText event.
    const onMatch = vi.fn();
    const detector = detectorFor('opensesame', onMatch);
    insertText('typing ');
    insertText('open');
    insertText('sesame');
    expect(onMatch).toHaveBeenCalledWith('opensesame');
    detector.detach();
  });
});

describe('keystroke detector — desktop keyboards', () => {
  it('counts a keydown/beforeinput pair as one keystroke', () => {
    // If the pair were double-counted the buffer would fill with doubled
    // letters and the code could never match.
    const onMatch = vi.fn();
    const detector = detectorFor('opensesame', onMatch);
    desktopType('practice ');
    desktopType('opensesame');
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(onMatch).toHaveBeenCalledWith('opensesame');
    detector.detach();
  });

  it('still matches doubled letters typed quickly on a physical keyboard', () => {
    const onMatch = vi.fn();
    const detector = detectorFor('hello', onMatch);
    desktopType('hello');
    expect(onMatch).toHaveBeenCalledWith('hello');
    detector.detach();
  });

  it('still works from keydown alone (no focused field)', () => {
    const onMatch = vi.fn();
    const detector = detectorFor('opensesame', onMatch);
    for (const char of 'opensesame') keydown(char);
    expect(onMatch).toHaveBeenCalledWith('opensesame');
    detector.detach();
  });

  it('detach removes every listener', () => {
    const detector = detectorFor('opensesame', vi.fn());
    detector.detach();
    expect(listeners.get('keydown')).toEqual([]);
    expect(listeners.get('beforeinput')).toEqual([]);
  });
});

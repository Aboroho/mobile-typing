export interface DoubleTapOptions {
  /** Taps must land within this window to count as a double tap. */
  maxIntervalMs?: number;
  /** Taps must land within this distance to count as the same gesture. */
  maxDistancePx?: number;
  onDoubleTap: (event: { x: number; y: number }) => void;
  /** Elements that must never trigger the gesture. */
  ignoreSelector?: string;
}

interface TapRecord {
  at: number;
  x: number;
  y: number;
  pointerType: string;
}

const DEFAULT_MAX_INTERVAL_MS = 350;
const DEFAULT_MAX_DISTANCE_PX = 48;

/**
 * Interactive and media-related elements. A tap on any of these — or inside
 * them — is never part of the gesture, so the emoji picker, the voice recorder,
 * playback controls, links and the composer all keep working normally.
 */
const DEFAULT_IGNORE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a',
  'label',
  'summary',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[data-secret-ignore]',
  '[data-no-double-tap]',
  'audio',
  'video',
  'canvas',
].join(',');

/**
 * Double-tap detector for the privacy lock.
 *
 * Uses **pointer events** (which unify touch, mouse and pen) and falls back to
 * touch events on engines without `PointerEvent`. Two safeguards keep it from
 * firing twice for one gesture:
 *  - only one listener family is attached, never both;
 *  - a `touch` tap suppresses any compatibility `mouse` tap that follows it
 *    within the interval.
 *
 * Listeners are passive and nothing calls `preventDefault()`, so scrolling and
 * text selection keep working.
 */
export function attachDoubleTapDetector(target: HTMLElement, options: DoubleTapOptions): () => void {
  const maxInterval = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const maxDistance = options.maxDistancePx ?? DEFAULT_MAX_DISTANCE_PX;
  const ignoreSelector = options.ignoreSelector ?? DEFAULT_IGNORE_SELECTOR;
  let previous: TapRecord | null = null;
  /** Timestamp of the last touch tap, used to drop synthesised mouse taps. */
  let lastTouchAt = -Infinity;

  function isIgnored(node: EventTarget | null): boolean {
    const element = node as HTMLElement | null;
    if (!element || typeof element.closest !== 'function') return false;
    return Boolean(element.closest(ignoreSelector));
  }

  function considerTap(record: TapRecord): void {
    // A touch tap followed immediately by a compatibility mouse tap is one
    // gesture, not two.
    if (record.pointerType === 'mouse' && record.at - lastTouchAt < maxInterval) return;
    if (record.pointerType === 'touch') lastTouchAt = record.at;

    const last = previous;
    previous = record;
    if (!last) return;

    const tooSlow = record.at - last.at > maxInterval;
    const tooFar = Math.hypot(record.x - last.x, record.y - last.y) > maxDistance;
    if (tooSlow || tooFar) return;

    previous = null;
    options.onDoubleTap({ x: record.x, y: record.y });
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isIgnored(event.target)) {
      previous = null;
      return;
    }
    considerTap({
      at: Date.now(),
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    });
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      previous = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    if (isIgnored(event.target)) {
      previous = null;
      return;
    }
    considerTap({ at: Date.now(), x: touch.clientX, y: touch.clientY, pointerType: 'touch' });
  };

  const supportsPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
  if (supportsPointer) {
    target.addEventListener('pointerdown', onPointerDown, { passive: true });
  } else {
    target.addEventListener('touchstart', onTouchStart, { passive: true });
  }

  return () => {
    if (supportsPointer) target.removeEventListener('pointerdown', onPointerDown);
    else target.removeEventListener('touchstart', onTouchStart);
    previous = null;
  };
}

export interface TripleTapOptions {
  /** Taps must land within this window to count as a triple tap. */
  maxIntervalMs?: number;
  /** Taps must land within this distance to count as the same gesture. */
  maxDistancePx?: number;
  onTripleTap: () => void;
  /** Ignore gestures that start on an interactive element. */
  ignoreSelector?: string;
}

interface TapRecord {
  at: number;
  x: number;
  y: number;
}

const DEFAULT_MAX_INTERVAL_MS = 480;
const DEFAULT_MAX_DISTANCE_PX = 40;

/**
 * Reliable triple-tap detector.
 *
 * Uses pointer events (which cover touch, mouse and pen) with both a time and a
 * distance threshold, so three quick taps in the same corner trigger the privacy
 * lock while ordinary scrolling and typing do not. A tap on a button, link or
 * input never counts.
 */
export function attachTripleTapDetector(target: HTMLElement, options: TripleTapOptions): () => void {
  const maxInterval = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const maxDistance = options.maxDistancePx ?? DEFAULT_MAX_DISTANCE_PX;
  const ignoreSelector = options.ignoreSelector ?? 'input, textarea, button, a, select, [role="button"]';
  const taps: TapRecord[] = [];

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const element = event.target as HTMLElement | null;
    if (element?.closest(ignoreSelector)) {
      taps.length = 0;
      return;
    }

    const now = event.timeStamp;
    const last = taps[taps.length - 1];
    if (last) {
      const tooSlow = now - last.at > maxInterval;
      const tooFar = Math.hypot(event.clientX - last.x, event.clientY - last.y) > maxDistance;
      if (tooSlow || tooFar) taps.length = 0;
    }

    taps.push({ at: now, x: event.clientX, y: event.clientY });
    if (taps.length < 3) return;

    taps.length = 0;
    // Stops the browser from turning the third tap into a double-tap zoom.
    event.preventDefault();
    options.onTripleTap();
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 3) event.preventDefault();
  };

  target.addEventListener('pointerdown', onPointerDown, { passive: true });
  // `touch-action: manipulation` is set in CSS; this guards triple-finger taps.
  target.addEventListener('touchstart', onTouchStart, { passive: false });

  return () => {
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('touchstart', onTouchStart);
  };
}

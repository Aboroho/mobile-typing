export interface DoubleTapOptions {
  /** The second tap must start within this many ms of the first tap ending. */
  maxIntervalMs?: number;
  /** Both taps must land within this distance of each other. */
  maxDistancePx?: number;
  /** A press that moves further than this is a scroll/drag, not a tap. */
  maxTapMovementPx?: number;
  /** A press held longer than this is a long press, not a tap. */
  maxTapDurationMs?: number;
  /** Gestures that start inside a matching element are ignored entirely. */
  ignoreSelector?: string;
  onDoubleTap: (event: PointerEvent | TouchEvent | MouseEvent) => void;
}

interface Tap {
  x: number;
  y: number;
  /** When the finger/button was released. */
  endedAt: number;
}

interface Press {
  pointerId: number | null;
  startX: number;
  startY: number;
  startedAt: number;
  moved: number;
}

export const DOUBLE_TAP_DEFAULTS = {
  maxIntervalMs: 350,
  maxDistancePx: 32,
  maxTapMovementPx: 12,
  maxTapDurationMs: 300,
} as const;

/**
 * Elements a privacy gesture must never be read from: anything the user
 * legitimately double-taps or double-clicks for another purpose (selecting a
 * word in the composer, tapping a button twice, seeking in an audio player,
 * picking two emoji quickly), plus an explicit opt-out attribute.
 */
export const DOUBLE_TAP_IGNORE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'label',
  'audio',
  'video',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[role="dialog"]',
  '[data-no-hide-gesture]',
].join(', ');

/**
 * Double-tap detector for the message area.
 *
 * Pointer events are used because they describe touch, mouse and pen with one
 * event sequence — so a touch never fires the gesture a second time through the
 * compatibility `mousedown`/`click` events. A "tap" is a press that ends quickly
 * and without moving, which keeps scrolling (a press that moves), long presses
 * (the context menu) and text selection out of the picture. Only the primary
 * pointer counts, so a pinch-zoom cannot register as two taps.
 *
 * Browsers without `PointerEvent` fall back to touch events plus mouse events
 * with a short suppression window after a touch.
 */
export function attachDoubleTapDetector(target: HTMLElement, options: DoubleTapOptions): () => void {
  const maxInterval = options.maxIntervalMs ?? DOUBLE_TAP_DEFAULTS.maxIntervalMs;
  const maxDistance = options.maxDistancePx ?? DOUBLE_TAP_DEFAULTS.maxDistancePx;
  const maxMovement = options.maxTapMovementPx ?? DOUBLE_TAP_DEFAULTS.maxTapMovementPx;
  const maxDuration = options.maxTapDurationMs ?? DOUBLE_TAP_DEFAULTS.maxTapDurationMs;
  const ignoreSelector = options.ignoreSelector ?? DOUBLE_TAP_IGNORE_SELECTOR;

  let press: Press | null = null;
  let lastTap: Tap | null = null;
  let lastTouchAt = 0;

  const shouldIgnore = (eventTarget: EventTarget | null): boolean => {
    const element = eventTarget instanceof Element ? eventTarget : null;
    return Boolean(element?.closest(ignoreSelector));
  };

  const begin = (pointerId: number | null, x: number, y: number, at: number, eventTarget: EventTarget | null) => {
    if (shouldIgnore(eventTarget)) {
      press = null;
      lastTap = null;
      return;
    }
    press = { pointerId, startX: x, startY: y, startedAt: at, moved: 0 };
  };

  const move = (pointerId: number | null, x: number, y: number) => {
    if (!press || press.pointerId !== pointerId) return;
    press.moved = Math.max(press.moved, Math.hypot(x - press.startX, y - press.startY));
  };

  const cancel = (pointerId: number | null) => {
    if (press && press.pointerId === pointerId) press = null;
  };

  const end = (pointerId: number | null, x: number, y: number, at: number, event: PointerEvent | TouchEvent | MouseEvent) => {
    const current = press;
    press = null;
    if (!current || current.pointerId !== pointerId) return;

    const moved = Math.max(current.moved, Math.hypot(x - current.startX, y - current.startY));
    const held = at - current.startedAt;
    if (moved > maxMovement || held > maxDuration) {
      // A scroll, drag or long press breaks any double-tap sequence.
      lastTap = null;
      return;
    }

    const tap: Tap = { x, y, endedAt: at };
    if (lastTap) {
      const interval = current.startedAt - lastTap.endedAt;
      const distance = Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y);
      if (interval >= 0 && interval <= maxInterval && distance <= maxDistance) {
        lastTap = null;
        options.onDoubleTap(event);
        return;
      }
    }
    lastTap = tap;
  };

  // --- Pointer events (all current browsers) -------------------------------
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    begin(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.target);
  };
  const onPointerMove = (event: PointerEvent) => move(event.pointerId, event.clientX, event.clientY);
  const onPointerUp = (event: PointerEvent) => end(event.pointerId, event.clientX, event.clientY, event.timeStamp, event);
  const onPointerCancel = (event: PointerEvent) => cancel(event.pointerId);

  // --- Fallback: touch + mouse -----------------------------------------------
  const onTouchStart = (event: TouchEvent) => {
    lastTouchAt = event.timeStamp;
    if (event.touches.length !== 1) {
      press = null;
      lastTap = null;
      return;
    }
    const touch = event.touches[0]!;
    begin(touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event.target);
  };
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) move(touch.identifier, touch.clientX, touch.clientY);
  };
  const onTouchEnd = (event: TouchEvent) => {
    lastTouchAt = event.timeStamp;
    const touch = event.changedTouches[0];
    if (touch) end(touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event);
  };
  const onTouchCancel = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (touch) cancel(touch.identifier);
  };
  const isSyntheticMouse = (event: MouseEvent) => event.timeStamp - lastTouchAt < 700;
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || isSyntheticMouse(event)) return;
    begin(null, event.clientX, event.clientY, event.timeStamp, event.target);
  };
  const onMouseMove = (event: MouseEvent) => move(null, event.clientX, event.clientY);
  const onMouseUp = (event: MouseEvent) => {
    if (isSyntheticMouse(event)) return;
    end(null, event.clientX, event.clientY, event.timeStamp, event);
  };

  const supportsPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
  // All listeners are passive: scrolling must never wait on this detector.
  const passive: AddEventListenerOptions = { passive: true };

  if (supportsPointer) {
    target.addEventListener('pointerdown', onPointerDown, passive);
    target.addEventListener('pointermove', onPointerMove, passive);
    target.addEventListener('pointerup', onPointerUp, passive);
    target.addEventListener('pointercancel', onPointerCancel, passive);
  } else {
    target.addEventListener('touchstart', onTouchStart, passive);
    target.addEventListener('touchmove', onTouchMove, passive);
    target.addEventListener('touchend', onTouchEnd, passive);
    target.addEventListener('touchcancel', onTouchCancel, passive);
    target.addEventListener('mousedown', onMouseDown, passive);
    target.addEventListener('mousemove', onMouseMove, passive);
    target.addEventListener('mouseup', onMouseUp, passive);
  }

  return () => {
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', onPointerUp);
    target.removeEventListener('pointercancel', onPointerCancel);
    target.removeEventListener('touchstart', onTouchStart);
    target.removeEventListener('touchmove', onTouchMove);
    target.removeEventListener('touchend', onTouchEnd);
    target.removeEventListener('touchcancel', onTouchCancel);
    target.removeEventListener('mousedown', onMouseDown);
    target.removeEventListener('mousemove', onMouseMove);
    target.removeEventListener('mouseup', onMouseUp);
  };
}

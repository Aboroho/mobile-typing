/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachDoubleTapDetector } from '@/lib/browser/double-tap';

let area: HTMLDivElement;
let detach: (() => void) | null = null;
let clock = 1000;

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit & { timeStamp?: number }) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'touch';
    this.isPrimary = init.isPrimary ?? true;
    const at = init.timeStamp ?? clock;
    Object.defineProperty(this, 'timeStamp', { value: at });
  }
}

function pointer(
  type: 'pointerdown' | 'pointerup' | 'pointermove' | 'pointercancel',
  target: Element,
  options: { x?: number; y?: number; at?: number; pointerId?: number; pointerType?: string; isPrimary?: boolean; button?: number } = {},
) {
  if (options.at !== undefined) clock = options.at;
  const event = new FakePointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.x ?? 100,
    clientY: options.y ?? 100,
    pointerId: options.pointerId ?? 1,
    pointerType: options.pointerType ?? 'touch',
    isPrimary: options.isPrimary ?? true,
    button: options.button ?? 0,
    timeStamp: clock,
  });
  target.dispatchEvent(event);
}

/** A clean tap: down then up at the same spot, 50 ms apart. */
function tap(target: Element, at: number, x = 100, y = 100, extra: { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {}) {
  pointer('pointerdown', target, { x, y, at, ...extra });
  pointer('pointerup', target, { x, y, at: at + 50, ...extra });
}

beforeEach(() => {
  clock = 1000;
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  area = document.createElement('div');
  document.body.appendChild(area);
});

afterEach(() => {
  detach?.();
  detach = null;
  area.remove();
  vi.unstubAllGlobals();
});

describe('attachDoubleTapDetector', () => {
  it('fires for two quick taps in the same place and only once per pair', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });

    tap(area, 1000);
    tap(area, 1200);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);

    // A third tap does not pair with the second one again.
    tap(area, 1400);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    // …but a fourth pairs with the third.
    tap(area, 1600);
    expect(onDoubleTap).toHaveBeenCalledTimes(2);
  });

  it('respects the configurable time threshold', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap, maxIntervalMs: 200 });
    tap(area, 1000);
    tap(area, 1400); // 350 ms after the first tap ended
    expect(onDoubleTap).not.toHaveBeenCalled();

    tap(area, 2000);
    tap(area, 2150);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('respects the distance threshold', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap, maxDistancePx: 20 });
    tap(area, 1000, 100, 100);
    tap(area, 1200, 160, 100);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('ignores scrolling and drags', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });
    // First "tap" is really the start of a scroll.
    pointer('pointerdown', area, { x: 100, y: 100, at: 1000 });
    pointer('pointermove', area, { x: 100, y: 180, at: 1050 });
    pointer('pointerup', area, { x: 100, y: 180, at: 1100 });
    tap(area, 1200);
    expect(onDoubleTap).not.toHaveBeenCalled();

    // A cancelled pointer (browser took over for scrolling) is not a tap either.
    pointer('pointerdown', area, { at: 2000 });
    pointer('pointercancel', area, { at: 2050 });
    tap(area, 2100);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('ignores long presses', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });
    pointer('pointerdown', area, { at: 1000 });
    pointer('pointerup', area, { at: 1600 });
    tap(area, 1700);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('ignores taps that start on interactive elements', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });
    area.innerHTML = `
      <button id="btn">Retry</button>
      <textarea id="ta"></textarea>
      <input id="in" />
      <a id="link" href="#">link</a>
      <audio id="audio" controls></audio>
      <div id="picker" role="dialog"><span id="emoji">😀</span></div>
      <div id="opt-out" data-no-hide-gesture><span id="inner">x</span></div>
      <p id="text">plain message text</p>
    `;
    for (const id of ['btn', 'ta', 'in', 'link', 'audio', 'emoji', 'inner']) {
      const element = area.querySelector(`#${id}`)!;
      tap(element, 1000);
      tap(element, 1200);
    }
    expect(onDoubleTap).not.toHaveBeenCalled();

    const text = area.querySelector('#text')!;
    tap(text, 3000);
    tap(text, 3200);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('does not let a tap on a button pair with a tap on the background', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });
    area.innerHTML = '<button id="btn">x</button>';
    tap(area, 1000);
    tap(area.querySelector('#btn')!, 1200);
    tap(area, 1400);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('ignores secondary pointers (pinch) and non-primary mouse buttons', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });
    tap(area, 1000, 100, 100, { pointerId: 2, isPrimary: false });
    tap(area, 1200, 100, 100, { pointerId: 2, isPrimary: false });
    expect(onDoubleTap).not.toHaveBeenCalled();

    pointer('pointerdown', area, { at: 2000, pointerType: 'mouse', button: 2 });
    pointer('pointerup', area, { at: 2050, pointerType: 'mouse', button: 2 });
    pointer('pointerdown', area, { at: 2100, pointerType: 'mouse', button: 2 });
    pointer('pointerup', area, { at: 2150, pointerType: 'mouse', button: 2 });
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('works with a mouse double click', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });
    tap(area, 1000, 50, 50, { pointerType: 'mouse' });
    tap(area, 1150, 52, 51, { pointerType: 'mouse' });
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('does not fire twice when compatibility mouse/click events follow a touch', () => {
    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });
    tap(area, 1000);
    tap(area, 1200);
    // Browsers synthesise these after touch; pointer mode must not listen to them.
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      area.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 100 }));
    }
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('detaches cleanly', () => {
    const onDoubleTap = vi.fn();
    const stop = attachDoubleTapDetector(area, { onDoubleTap });
    stop();
    tap(area, 1000);
    tap(area, 1200);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });
});

describe('attachDoubleTapDetector without PointerEvent support', () => {
  it('falls back to touch events and suppresses the synthesised mouse events', () => {
    vi.unstubAllGlobals();
    // jsdom has no PointerEvent by default; make sure of it.
    (window as unknown as { PointerEvent?: unknown }).PointerEvent = undefined;
    delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;

    const onDoubleTap = vi.fn();
    detach = attachDoubleTapDetector(area, { onDoubleTap });

    const touchEvent = (type: string, at: number, x = 100, y = 100) => {
      const touch = { identifier: 1, clientX: x, clientY: y, target: area } as unknown as Touch;
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      Object.defineProperty(event, 'timeStamp', { value: at });
      area.dispatchEvent(event);
    };
    const mouseEvent = (type: string, at: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 100, button: 0 });
      Object.defineProperty(event, 'timeStamp', { value: at });
      area.dispatchEvent(event);
    };

    touchEvent('touchstart', 1000);
    touchEvent('touchend', 1050);
    // Synthesised mouse events after the first touch must not count as a tap.
    mouseEvent('mousedown', 1060);
    mouseEvent('mouseup', 1070);
    touchEvent('touchstart', 1200);
    touchEvent('touchend', 1250);
    mouseEvent('mousedown', 1260);
    mouseEvent('mouseup', 1270);

    expect(onDoubleTap).toHaveBeenCalledTimes(1);

    // Real mouse (long after any touch) still works.
    mouseEvent('mousedown', 5000);
    mouseEvent('mouseup', 5050);
    mouseEvent('mousedown', 5200);
    mouseEvent('mouseup', 5250);
    expect(onDoubleTap).toHaveBeenCalledTimes(2);
  });
});

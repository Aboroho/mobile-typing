/**
 * @vitest-environment jsdom
 *
 * Double-tap gesture: thresholds, and the elements that must never trigger it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachDoubleTapDetector } from '@/lib/browser/double-tap';

/**
 * jsdom has no PointerEvent (a long-standing gap, not a browser one). Every
 * engine this app targets does, so the tests polyfill it on top of MouseEvent
 * rather than testing a code path real users never take.
 */
class PointerEventPolyfill extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
    (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  }
});

function pointerDown(target: Element, options: { x?: number; y?: number; at?: number; type?: string } = {}) {
  const event = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: options.x ?? 100,
    clientY: options.y ?? 100,
    pointerType: options.type ?? 'touch',
    button: 0,
  } as PointerEventInit & { pointerType?: string });
  target.dispatchEvent(event);
  return event;
}

describe('double-tap detector', () => {
  let root: HTMLDivElement;
  let detaches: Array<() => void> = [];
  let taps: Array<{ x: number; y: number }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.innerHTML = `
      <div id="surface">
        <p id="plain">message text</p>
        <button id="btn">Send</button>
        <input id="input" />
        <textarea id="area"></textarea>
        <a id="link" href="#">link</a>
        <div id="emoji" data-no-double-tap="true">😀</div>
        <audio id="audio" controls></audio>
      </div>`;
    document.body.appendChild(root);
    taps = [];
    detaches = [attachDoubleTapDetector(root, { onDoubleTap: (event) => taps.push(event) })];
  });

  afterEach(() => {
    for (const detach of detaches) detach();
    detaches = [];
    vi.useRealTimers();
  });

  const surface = () => document.getElementById('plain')!;

  it('fires on two quick taps in the same place', () => {
    vi.setSystemTime(1000);
    pointerDown(surface());
    vi.setSystemTime(1150);
    pointerDown(surface());
    expect(taps).toHaveLength(1);
  });

  it('does not fire when the taps are too far apart in time', () => {
    vi.setSystemTime(1000);
    pointerDown(surface());
    vi.setSystemTime(2000);
    pointerDown(surface());
    expect(taps).toHaveLength(0);
  });

  it('does not fire when the taps are too far apart in space', () => {
    vi.setSystemTime(1000);
    pointerDown(surface(), { x: 10, y: 10 });
    vi.setSystemTime(1100);
    pointerDown(surface(), { x: 400, y: 400 });
    expect(taps).toHaveLength(0);
  });

  it('respects a custom time threshold', () => {
    detaches.push(attachDoubleTapDetector(root, { maxIntervalMs: 50, onDoubleTap: () => taps.push({ x: 0, y: 0 }) }));
    vi.setSystemTime(1000);
    pointerDown(surface());
    vi.setSystemTime(1080);
    pointerDown(surface());
    // The default detector (350ms) fires; the 50ms one does not.
    expect(taps).toHaveLength(1);
  });

  it.each([
    ['button', 'btn'],
    ['input', 'input'],
    ['textarea', 'area'],
    ['link', 'link'],
    ['emoji picker', 'emoji'],
    ['audio control', 'audio'],
  ])('never fires from a %s', (_label, id) => {
    const element = document.getElementById(id)!;
    vi.setSystemTime(1000);
    pointerDown(element);
    vi.setSystemTime(1100);
    pointerDown(element);
    expect(taps).toHaveLength(0);
  });

  it('counts one gesture as one tap when each touch is followed by a compatibility mouse event', () => {
    // Browsers that emit both fire touch then a synthesised mouse event for the
    // *same* physical tap. Two real taps must therefore produce exactly one
    // double-tap, not two and not zero.
    vi.setSystemTime(1000);
    pointerDown(surface(), { type: 'touch' });
    vi.setSystemTime(1010);
    pointerDown(surface(), { type: 'mouse' });
    expect(taps).toHaveLength(0);

    vi.setSystemTime(1150);
    pointerDown(surface(), { type: 'touch' });
    vi.setSystemTime(1160);
    pointerDown(surface(), { type: 'mouse' });
    expect(taps).toHaveLength(1);
  });

  it('ignores right-click', () => {
    vi.setSystemTime(1000);
    pointerDown(surface(), { type: 'mouse' });
    const event = new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: 100,
      clientY: 100,
      pointerType: 'mouse',
      button: 2,
    });
    vi.setSystemTime(1100);
    surface().dispatchEvent(event);
    expect(taps).toHaveLength(0);
  });

  it('stops reporting after detach', () => {
    for (const detach of detaches) detach();
    detaches = [];
    vi.setSystemTime(1000);
    pointerDown(surface());
    vi.setSystemTime(1100);
    pointerDown(surface());
    expect(taps).toHaveLength(0);
  });
});

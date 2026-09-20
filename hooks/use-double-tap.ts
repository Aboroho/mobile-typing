'use client';

import { useEffect, useRef } from 'react';
import { attachDoubleTapDetector, type DoubleTapOptions } from '@/lib/browser/double-tap';

/**
 * Double-tap privacy lock for the message area.
 *
 * `enabled` lets the typing game and the sign-in panel opt out. The callback is
 * kept in a ref so a re-render (a new message arriving, a typing indicator
 * flipping) never re-attaches the listener and drops a half-finished gesture.
 */
export function useDoubleTap(
  target: React.RefObject<HTMLElement | null>,
  onDoubleTap: DoubleTapOptions['onDoubleTap'],
  enabled = true,
): void {
  const handler = useRef(onDoubleTap);
  handler.current = onDoubleTap;

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const element = target.current;
    if (!element) return;
    return attachDoubleTapDetector(element, {
      onDoubleTap: (event) => handler.current(event),
    });
  }, [target, enabled]);
}

'use client';

import { useEffect, type RefObject } from 'react';
import { attachDoubleTapDetector, type DoubleTapOptions } from '@/lib/browser/double-tap';

/**
 * Double-tap gesture on a specific element (the message area). Interactive
 * children are ignored by the detector; see `DOUBLE_TAP_IGNORE_SELECTOR`.
 */
export function useDoubleTap(
  ref: RefObject<HTMLElement | null>,
  onDoubleTap: DoubleTapOptions['onDoubleTap'],
  options: Omit<DoubleTapOptions, 'onDoubleTap'> & { enabled?: boolean } = {},
): void {
  const { enabled = true, maxIntervalMs, maxDistancePx, maxTapMovementPx, maxTapDurationMs, ignoreSelector } = options;
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    return attachDoubleTapDetector(element, {
      onDoubleTap,
      maxIntervalMs,
      maxDistancePx,
      maxTapMovementPx,
      maxTapDurationMs,
      ignoreSelector,
    });
  }, [ref, enabled, onDoubleTap, maxIntervalMs, maxDistancePx, maxTapMovementPx, maxTapDurationMs, ignoreSelector]);
}

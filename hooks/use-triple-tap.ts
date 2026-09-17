'use client';

import { useEffect } from 'react';
import { attachTripleTapDetector } from '@/lib/browser/triple-tap';

/**
 * Triple-tap privacy lock. `enabled` lets the game screen opt out so that a
 * frustrated typist cannot lock themselves out of the game.
 */
export function useTripleTap(onTripleTap: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    return attachTripleTapDetector(document.body, { onTripleTap });
  }, [onTripleTap, enabled]);
}

'use client';

import { useEffect, useRef } from 'react';
import type { AccessChallenge } from '@mt/types';
import { attachKeystrokeDetector } from '@/lib/browser/keystroke-detector';
import { useAccessStore } from '@/stores/access-store';

/**
 * Wires the rolling secret-code buffer to the typing game.
 *
 * The detector is only attached while an access challenge is active, is
 * detached as soon as the user unlocks, and never buffers keystrokes typed into
 * password/email fields.
 */
export function useKeystrokeUnlock(challenge: AccessChallenge | null): void {
  const unlockWithCode = useAccessStore((state) => state.unlockWithCode);
  const detectorRef = useRef<{ reset: () => void; detach: () => void } | null>(null);

  useEffect(() => {
    if (!challenge) return;
    detectorRef.current = attachKeystrokeDetector({
      code: challenge.code,
      maxLength: challenge.maxLength,
      caseSensitive: challenge.caseSensitive,
      onMatch: (code) => {
        void unlockWithCode(code);
      },
    });
    return () => {
      detectorRef.current?.detach();
      detectorRef.current = null;
    };
  }, [challenge, unlockWithCode]);
}

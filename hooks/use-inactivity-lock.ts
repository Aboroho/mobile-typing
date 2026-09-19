'use client';

import { useEffect } from 'react';
import { CHAT_HIDDEN_LOCK_MS } from '@mt/types';
import { createHiddenTimer, sessionStampStorage } from '@/lib/browser/hidden-timer';
import { hideChat } from '@/lib/client/privacy-lock';
import { useAccessStore } from '@/stores/access-store';
import { stopAllTyping } from '@/stores/chat-store';

/**
 * Inactivity privacy lock.
 *
 * Rule: the chat closes (and the typing game returns) once the page has been
 * **hidden** for more than `CHAT_HIDDEN_LOCK_MS` (60 s). Coming back sooner
 * changes nothing — the conversation, scroll position and draft are all kept.
 *
 * "Hidden" is the Page Visibility notion: another tab in front, the window
 * minimised, the phone screen locked or the browser sent to the background.
 * Signals used: `visibilitychange`, `pagehide`/`pageshow` (back-forward cache),
 * `freeze`/`resume` (Page Lifecycle, Chromium).
 *
 * Deliberately **not** a hide: `blur`. A chat that is visible next to another
 * window, a browser dev-tools pane, a system dialog or a second monitor keeps
 * working — messages arrive, receipts flow, calls continue. `focus` is used
 * only as an extra opportunity to re-check the stamp, never as a trigger.
 *
 * Reliability: background tabs throttle timers and mobile browsers suspend
 * JavaScript entirely, so the 60 s timer may fire late or not at all while the
 * page is away. That is fine — the *stamp* taken when the page was hidden is
 * compared the instant it becomes visible again (and on the next page load,
 * via `sessionStorage`), so the chat is closed before anything is painted for
 * a user who was away too long. What cannot be promised is that the server
 * session is revoked *while* the page is suspended; until the revoke request
 * is sent the httpOnly access cookie stays valid up to its own TTL.
 */
export function useInactivityLock(enabled: boolean, thresholdMs: number = CHAT_HIDDEN_LOCK_MS): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    const timer = createHiddenTimer({
      thresholdMs,
      isHidden: () => document.visibilityState === 'hidden',
      storage: sessionStampStorage(),
      onExpire: ({ hiddenForMs }) => hideChat('inactivity', { hiddenForMs }),
    });

    const onHidden = () => {
      // Only an open chat needs a countdown; the game screen has nothing to hide.
      if (!useAccessStore.getState().unlocked) return;
      stopAllTyping();
      timer.hidden();
    };
    const onVisible = () => {
      if (document.visibilityState === 'hidden') return;
      timer.visible();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') onHidden();
      else onVisible();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('pageshow', onVisible);
    // Page Lifecycle API (Chromium): a frozen page gets no timers at all.
    document.addEventListener('freeze', onHidden);
    document.addEventListener('resume', onVisible);
    // Focus is a cheap moment to re-check a stamp; it never starts one.
    window.addEventListener('focus', onVisible);

    // A tab restored after being discarded, or reloaded while away: judge by
    // the stamp left behind by the previous page lifetime.
    timer.restore();

    return () => {
      timer.dispose();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onHidden);
      window.removeEventListener('pageshow', onVisible);
      document.removeEventListener('freeze', onHidden);
      document.removeEventListener('resume', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [enabled, thresholdMs]);
}

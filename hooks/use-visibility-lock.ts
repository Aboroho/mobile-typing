'use client';

import { useEffect } from 'react';
import { disconnectAllStreams } from '@/stores/chat-store';
import { endCallForPrivacyLock } from '@/stores/call-store';
import { useAccessStore } from '@/stores/access-store';
import { useUiStore } from '@/stores/ui-store';
import { createVisibilityPolicy, VISIBILITY_GRACE_MS } from '@/lib/browser/visibility-policy';

/**
 * Page lifecycle handling for the privacy lock.
 *
 * The rule is time based, not focus based:
 *
 *  - `visibilitychange` → hidden, and `pagehide`, start a 60 second timer;
 *  - if the page is still hidden when it fires, the chat is locked: the access
 *    session is revoked server side, live streams are dropped, in-memory chat
 *    state is cleared and any call is ended with reason `privacy_lock`. The
 *    user returns to the typing game and has to unlock again;
 *  - coming back before the timer expires cancels it and preserves the chat;
 *  - `blur` / `focus` alone do **not** lock. Switching to another window,
 *    clicking the address bar or taking a screenshot leaves the page visible,
 *    so the chat stays usable — only real backgrounding counts.
 *
 * Documented platform limitation: mobile browsers suspend timers when an app is
 * backgrounded, so the 60 second timer may not fire while suspended. `pagehide`
 * and `freeze` are handled for that case, and the server-side access session
 * expiry is the backstop — the client timer is defence in depth, not the only
 * protection.
 */
export function useVisibilityLock(enabled: boolean, graceMs: number = VISIBILITY_GRACE_MS): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    const lock = () => {
      const access = useAccessStore.getState();
      if (!access.unlocked) return;
      useUiStore.getState().setPrivacyLocked(true);
      disconnectAllStreams();
      void endCallForPrivacyLock();
      void access.lock({ silent: true });
    };

    const policy = createVisibilityPolicy({ graceMs, onLock: lock });

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') policy.onHidden();
      else policy.onVisible();
    };
    const onPageHide = () => policy.onHidden();
    const onPageShow = () => policy.onVisible();
    // `blur` is not a lock trigger. It only counts when the page really is
    // hidden, which some mobile engines report through blur instead of
    // visibilitychange.
    const onBlur = () => {
      if (document.visibilityState === 'hidden') policy.onHidden();
    };
    const onFocus = () => {
      if (document.visibilityState === 'visible') policy.onVisible();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('freeze', onVisibilityChange as EventListener);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);

    return () => {
      policy.dispose();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('freeze', onVisibilityChange as EventListener);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, graceMs]);
}

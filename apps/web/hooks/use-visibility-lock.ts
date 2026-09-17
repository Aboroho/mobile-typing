'use client';

import { useEffect } from 'react';
import { disconnectAllStreams } from '@/stores/chat-store';
import { endCallForPrivacyLock } from '@/stores/call-store';
import { useAccessStore } from '@/stores/access-store';
import { useUiStore } from '@/stores/ui-store';

/**
 * Page Visibility / blur handling.
 *
 * When the tab is hidden or the window loses focus the chat is locked: the
 * access session is revoked server side, live streams are dropped and any call
 * is ended with reason `privacy_lock`. Browsers do not guarantee these events
 * fire (documented limitation), so this is defence in depth on top of the
 * server-side access session expiry.
 */
export function useVisibilityLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    const lock = (reason: 'hidden' | 'blur') => {
      const access = useAccessStore.getState();
      if (!access.unlocked) return;
      useUiStore.getState().setPrivacyLocked(true);
      disconnectAllStreams();
      void endCallForPrivacyLock();
      void access.lock({ silent: true });
      void reason;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') lock('hidden');
    };
    const onBlur = () => lock('blur');
    const onReveal = () => useUiStore.getState().setPrivacyLocked(false);
    const onPageHide = () => lock('hidden');

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onReveal);
    window.addEventListener('pagehide', onPageHide);
    // iOS Safari fires freeze rather than visibilitychange on backgrounding.
    document.addEventListener('freeze', onVisibilityChange as EventListener);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onReveal);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('freeze', onVisibilityChange as EventListener);
    };
  }, [enabled]);
}

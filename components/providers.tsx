'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useCallStore } from '@/stores/call-store';
import { initTheme, useUiStore } from '@/stores/ui-store';
import { useAccessGateOpen, useAccessStore } from '@/stores/access-store';
import { useRealtimeStore } from '@/stores/realtime-store';
import { ToastHost } from '@/components/ui/toast-host';
import { CallOverlay } from '@/components/audio-calls/call-overlay';

/**
 * Global client bootstrap: theme, session restore, access-session expiry
 * handling, the call listener and the toast host.
 */
export function RootProviders({ children }: { children: React.ReactNode }) {
  const initialize = useAuthStore((state) => state.initialize);
  const user = useAuthStore((state) => state.user);
  const handleSessionRequired = useAuthStore((state) => state.handleSessionRequired);
  const lock = useAccessStore((state) => state.lock);
  const refreshAccess = useAccessStore((state) => state.refresh);
  const setPrivacyLocked = useUiStore((state) => state.setPrivacyLocked);
  // A signed-in browser is not the same thing as an *unlocked* one: the session
  // cookie lasts two weeks, the access session thirty minutes. Anything that
  // talks to a user-scoped API has to wait for both.
  const accessOpen = useAccessGateOpen();
  const gateOpen = Boolean(user) && accessOpen;

  useEffect(() => {
    initTheme();
    void refreshAccess();
    void initialize();
  }, [initialize, refreshAccess]);

  /**
   * The realtime transport is only brought up once the access gate is open.
   * Opening it earlier (a restored session on the typing-game screen, or an
   * access session that quietly expired while the tab was open) makes the
   * server reject every call/incoming-call stream with 403 `ACCESS_REQUIRED`
   * and the client retry it forever — a wall of 403s for a browser that is
   * sitting on the typing game.
   */
  useEffect(() => {
    if (!gateOpen) {
      useRealtimeStore.getState().stop();
      return;
    }
    useRealtimeStore.getState().start();
  }, [gateOpen]);

  // A revoked/expired access session (403 ACCESS_REQUIRED) returns to the game.
  useEffect(() => {
    const onAccessRequired = () => {
      setPrivacyLocked(true);
      void lock({ silent: true });
    };
    globalThis.addEventListener('mt:access-required', onAccessRequired);
    return () => globalThis.removeEventListener('mt:access-required', onAccessRequired);
  }, [lock, setPrivacyLocked]);

  // A rejected session (401 UNAUTHENTICATED / 403 ACCOUNT_DISABLED)
  // drops the session, so the sign-in panel returns instead of every request
  // failing quietly behind a UI that still looks authenticated.
  useEffect(() => {
    const onAuthRequired = () => handleSessionRequired();
    globalThis.addEventListener('mt:auth-required', onAuthRequired);
    return () => globalThis.removeEventListener('mt:auth-required', onAuthRequired);
  }, [handleSessionRequired]);

  return (
    <>
      {children}
      {gateOpen ? <CallListener /> : null}
      <CallOverlay />
      <ToastHost />
    </>
  );
}

function CallListener() {
  const startListening = useCallStore((state) => state.startListening);
  useEffect(() => startListening(), [startListening]);
  return null;
}

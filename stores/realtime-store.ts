import { create } from 'zustand';
import { getRealtimeClient, type RealtimeStatus } from '@/lib/browser/realtime-client';
import { isAccessGateOpen } from './access-store';
import { useUiStore } from './ui-store';

/**
 * Realtime connection state.
 *
 * Kept in its own store, deliberately separate from `auth-store`: a socket that
 * will not connect is a *connectivity* problem, and it must never be able to
 * turn a completed signup, login or message send into a reported failure. The
 * UI reads `warning` to show an independent banner.
 */
interface RealtimeState {
  status: RealtimeStatus;
  detail: string | null;
  /** Short user-facing message, or null when the transport is healthy. */
  warning: string | null;
  started: boolean;
  init: () => void;
  /** Connects (idempotent). Safe to call after signup, login or a reconnect. */
  start: () => void;
  stop: () => void;
}

function warningFor(status: RealtimeStatus): string | null {
  switch (status) {
    case 'websocket':
    case 'sse':
      return null;
    case 'connecting':
      return null;
    case 'offline':
      return 'Live updates are paused — messages still send, and missed ones appear on refresh.';
    default:
      return null;
  }
}

export const useRealtimeStore = create<RealtimeState>((set, get) => ({
  status: 'idle',
  detail: null,
  warning: null,
  started: false,

  init() {
    if (typeof window === 'undefined') return;
    const client = getRealtimeClient();
    client.onStatus((status, detail) => {
      set({ status, detail: detail ?? null, warning: warningFor(status) });
    });
    // Coming back online is the cheapest trigger for a retry.
    window.addEventListener('online', () => get().start());
  },

  start() {
    if (typeof window === 'undefined') return;
    /*
     * Every event on this transport belongs to a signed-in, *unlocked* user: the
     * call and conversation routes answer 403 `ACCESS_REQUIRED` otherwise, and a
     * rejected SSE stream looks exactly like a flaky network, so the client
     * would retry it forever. Restoring a session and signing in both happen
     * before the secret-code gate is open, so connecting is deferred to
     * `RootProviders`, which starts the transport the moment the gate opens.
     */
    if (!isAccessGateOpen()) return;
    if (!get().started) {
      get().init();
      set({ started: true });
    }
    try {
      getRealtimeClient().connect();
    } catch (error) {
      // A transport failure is reported, never thrown: signup/login must not
      // inherit it.
      set({ status: 'offline', detail: String(error), warning: warningFor('offline') });
      useUiStore
        .getState()
        .pushToast('Live updates unavailable — your messages are still saved.', 'error');
    }
  },

  stop() {
    if (typeof window === 'undefined') return;
    try {
      getRealtimeClient().disconnect();
    } catch {
      /* already down */
    }
    set({ status: 'idle', detail: null, warning: null });
  },
}));

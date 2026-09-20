import { create } from 'zustand';
import type { CallSignalKind, CallView, IceServer } from '@mt/types';
import { api } from '@/lib/client/api';
import { connectEventStream } from '@/lib/browser/sse-client';
import { accessSessionGone } from '@/lib/browser/access-session';
import { CallManager, type CallClientState } from '@/lib/webrtc/call-manager';
import { useUiStore } from './ui-store';
import { errorMessage } from './access-store';

interface CallState {
  /** Incoming call awaiting an answer. */
  incoming: CallView | null;
  call: CallView | null;
  state: CallClientState;
  muted: boolean;
  remoteMuted: boolean;
  durationMs: number;
  error: string | null;
  iceServers: IceServer[];

  startListening: () => () => void;
  startCall: (conversationId: string) => Promise<void>;
  acceptIncoming: () => Promise<void>;
  rejectIncoming: () => Promise<void>;
  hangup: (reason?: 'hangup' | 'privacy_lock') => Promise<void>;
  toggleMute: () => void;
}

let manager: CallManager | null = null;
let callStream: (() => void) | null = null;
/** Latest ICE diagnostics, exposed for the call screen's status line. */
let diagnostics: {
  iceState: string | null;
  connectionState: string | null;
  turnUsed: boolean;
} | null = null;

export function getCallDiagnostics(): typeof diagnostics {
  return diagnostics;
}

export const useCallStore = create<CallState>((set, get) => ({
  incoming: null,
  call: null,
  state: 'idle',
  muted: false,
  remoteMuted: false,
  durationMs: 0,
  error: null,
  iceServers: [],

  /** Subscribes to incoming-call + signalling events for the signed-in user. */
  startListening() {
    callStream?.();
    callStream = connectEventStream({
      url: '/api/v1/calls/events',
      events: {
        'call.incoming': (payload) => {
          const call = (payload as { call: CallView }).call;
          set({ incoming: call, call });
          // A short vibration where supported: the audio cue needs a user gesture.
          navigator.vibrate?.([120, 80, 120]);
        },
        'call.outgoing': (payload) => {
          set({ call: (payload as { call: CallView }).call });
        },
        'call.state': (payload) => {
          const call = (payload as { call: CallView }).call;
          set({ call });
          if (['ended', 'missed', 'rejected', 'cancelled', 'failed'].includes(call.status)) {
            teardown();
            set({ incoming: null, call: null, state: 'idle', durationMs: 0 });
          }
        },
        'call.accepted': () => {
          manager?.markActive();
          set({ state: 'active' });
        },
        'signal.offer': (payload) => void handleSignal('offer', payload),
        'signal.answer': (payload) => void handleSignal('answer', payload),
        'signal.ice-candidate': (payload) => void handleSignal('ice-candidate', payload),
        'signal.mute': (payload) => void handleSignal('mute', payload),
        'signal.unmute': (payload) => void handleSignal('unmute', payload),
        'signal.bye': (payload) => void handleSignal('bye', payload),
      },
      /**
       * The stream answers 403 `ACCESS_REQUIRED` while this browser has no
       * access session (the 30 minute window elapsed, or the chat was hidden).
       * `EventSource` hides the status, so ask the API instead of retrying a
       * route this browser may not read — and hand the decision back to the app
       * so the typing game returns.
       */
      shouldReconnect: async () => {
        if (!(await accessSessionGone())) return true;
        callStream?.();
        callStream = null;
        globalThis.dispatchEvent(new CustomEvent('mt:access-required'));
        return false;
      },
    });
    return () => callStream?.();
  },

  async startCall(conversationId) {
    try {
      const { call, iceServers } = await api.calls.create({ conversationId });
      set({ call, iceServers, error: null, muted: false, remoteMuted: false, durationMs: 0 });
      manager = createManager({ callId: call.id, iceServers, isInitiator: true, set, get });
      await manager.startOutgoing();
    } catch (error) {
      set({ error: errorMessage(error), state: 'idle' });
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async acceptIncoming() {
    const incoming = get().incoming;
    if (!incoming) return;
    try {
      const { iceServers } = await api.calls.iceServers();
      await api.calls.accept(incoming.id);
      set({
        incoming: null,
        iceServers,
        error: null,
        muted: false,
        remoteMuted: false,
        durationMs: 0,
      });
      manager = createManager({ callId: incoming.id, iceServers, isInitiator: false, set, get });
      await manager.prepareIncoming();
    } catch (error) {
      set({ error: errorMessage(error) });
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    }
  },

  async rejectIncoming() {
    const incoming = get().incoming;
    if (!incoming) return;
    await api.calls.reject(incoming.id, 'declined').catch(() => undefined);
    set({ incoming: null, call: null, state: 'idle' });
  },

  async hangup(reason = 'hangup') {
    const call = get().call;
    if (call) {
      await api.calls
        .end(call.id, { reason, durationMs: manager?.durationMs ?? 0 })
        .catch(() => undefined);
    }
    await manager?.hangup().catch(() => undefined);
    teardown();
    set({ call: null, incoming: null, state: 'idle', durationMs: 0, muted: false });
  },

  toggleMute() {
    const next = !get().muted;
    manager?.setMuted(next);
    set({ muted: next });
  },
}));

function teardown(): void {
  manager?.dispose();
  manager = null;
}

interface ManagerDeps {
  callId: string;
  iceServers: IceServer[];
  isInitiator: boolean;
  set: (partial: Partial<CallState>) => void;
  get: () => CallState;
}

function createManager(deps: ManagerDeps): CallManager {
  return new CallManager({
    callId: deps.callId,
    iceServers: deps.iceServers,
    isInitiator: deps.isInitiator,
    sendSignal: (kind, payload) =>
      api.calls.signal(deps.callId, {
        kind,
        payload: payload as unknown as Record<string, unknown>,
      }),
    onState: (state) => deps.set({ state }),
    onRemoteMuted: (remoteMuted) => deps.set({ remoteMuted }),
    onDurationTick: (durationMs) => deps.set({ durationMs }),
    onDiagnostics: (info) => {
      // Diagnostics stay client side; a failed TURN negotiation shows up as a
      // "reconnecting" state rather than silent audio.
      diagnostics = info;
    },
    onError: (error) => {
      deps.set({ error: error.message });
      useUiStore.getState().pushToast(error.message, 'error');
    },
  });
}

async function handleSignal(kind: CallSignalKind, payload: unknown): Promise<void> {
  if (!manager) return;
  await manager.handleSignal(kind, payload as Record<string, never>).catch(() => undefined);
}

/** Ends any call when the tab is hidden — documented privacy behaviour. */
export async function endCallForPrivacyLock(): Promise<void> {
  const state = useCallStore.getState();
  if (!state.call && !state.incoming) return;
  await state.hangup('privacy_lock');
}

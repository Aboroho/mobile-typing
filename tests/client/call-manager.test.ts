/**
 * @vitest-environment jsdom
 *
 * WebRTC call controller: signalling, state transitions, TURN diagnostics and —
 * most importantly — that every resource is released when a call ends, so a
 * refresh or a hangup never leaves a microphone open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallManager, type CallClientState } from '@/lib/webrtc/call-manager';

class FakeTrack {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  closed = false;
  iceConnectionState = 'new';
  connectionState = 'new';
  localDescription: { sdp: string; type: string } | null = null;
  addedCandidates: unknown[] = [];
  onicecandidate: ((event: { candidate: { candidate: string; toJSON(): unknown } } | null) => void) | null = null;
  ontrack: ((event: { track: FakeTrack; streams: MediaStream[] }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  readonly config: unknown;

  constructor(config: unknown) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  addTrack() {
    /* noop */
  }
  async createOffer(options?: { iceRestart?: boolean }) {
    return { sdp: options?.iceRestart ? 'restarted-sdp' : 'offer-sdp', type: 'offer' };
  }
  async createAnswer() {
    return { sdp: 'answer-sdp', type: 'answer' };
  }
  async setLocalDescription(description: { sdp: string; type: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription() {
    /* noop */
  }
  async addIceCandidate(candidate: unknown) {
    this.addedCandidates.push(candidate);
  }
  close() {
    this.closed = true;
  }
}

function fakeMediaDevices(deny = false) {
  const track = new FakeTrack();
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  return {
    track,
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        if (deny) {
          const error = new Error('denied') as Error & { name: string };
          error.name = 'NotAllowedError';
          throw error;
        }
        return stream;
      }),
    },
  };
}

describe('CallManager', () => {
  let states: CallClientState[] = [];
  let signals: Array<{ kind: string; payload: unknown }> = [];
  let diagnostics: Array<{ iceState: string | null; turnUsed: boolean }> = [];
  let manager: CallManager;

  function make(isInitiator = true) {
    states = [];
    signals = [];
    diagnostics = [];
    manager = new CallManager({
      callId: 'call_1',
      iceServers: [{ urls: 'stun:stun.example.org' }] as never,
      isInitiator,
      sendSignal: async (kind, payload) => {
        signals.push({ kind, payload });
        return { accepted: true };
      },
      onState: (state) => states.push(state),
      onRemoteMuted: () => undefined,
      onDurationTick: () => undefined,
      onDiagnostics: (info) => diagnostics.push({ iceState: info.iceState, turnUsed: info.turnUsed }),
      onError: () => undefined,
    });
    return manager;
  }

  beforeEach(() => {
    FakePeerConnection.instances = [];
    const { mediaDevices } = fakeMediaDevices();
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection as unknown as typeof RTCPeerConnection);
    vi.stubGlobal('navigator', { ...navigator, mediaDevices, vibrate: () => true });
    vi.stubGlobal('MediaStream', class {} as unknown as typeof MediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('initiator: mic → offer → ringing', async () => {
    make(true);
    await manager.startOutgoing();
    expect(states).toEqual(['requesting-microphone', 'connecting', 'ringing']);
    expect(signals[0]?.kind).toBe('offer');
    expect((signals[0]?.payload as { sdp: string }).sdp).toBe('offer-sdp');
  });

  it('recipient: answers an offer', async () => {
    make(false);
    await manager.prepareIncoming();
    await manager.handleSignal('offer', { sdp: 'offer-sdp', type: 'offer' });
    expect(signals.map((s) => s.kind)).toContain('answer');
    expect(states.at(-1)).toBe('connecting');
  });

  it('queues ICE candidates until the remote description is set', async () => {
    make(false);
    await manager.prepareIncoming();
    await manager.handleSignal('ice-candidate', { candidate: { candidate: 'early' } });
    expect(FakePeerConnection.instances[0]!.addedCandidates).toHaveLength(0);
    await manager.handleSignal('offer', { sdp: 'offer-sdp', type: 'offer' });
    expect(FakePeerConnection.instances[0]!.addedCandidates).toHaveLength(1);
  });

  it('reports a microphone permission failure with a readable message', async () => {
    const { mediaDevices } = fakeMediaDevices(true);
    vi.stubGlobal('navigator', { ...navigator, mediaDevices, vibrate: () => true });
    make(true);
    await expect(manager.startOutgoing()).rejects.toThrow('microphone permission was denied');
  });

  it('detects a TURN relay candidate', async () => {
    make(true);
    await manager.startOutgoing();
    const pc = FakePeerConnection.instances[0]!;
    pc.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 relay', toJSON: () => ({}) } });
    pc.iceConnectionState = 'connected';
    pc.oniceconnectionstatechange?.();
    expect(diagnostics.at(-1)).toMatchObject({ iceState: 'connected', turnUsed: true });
  });

  it('restarts ICE when the connection fails', async () => {
    make(true);
    await manager.startOutgoing();
    const pc = FakePeerConnection.instances[0]!;
    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toContain('reconnecting');
    expect(signals.some((s) => s.kind === 'offer' && (s.payload as { sdp: string }).sdp === 'restarted-sdp')).toBe(true);
  });

  it('hangup signals the peer, stops the microphone and closes the peer connection', async () => {
    const { track } = fakeMediaDevices();
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
      vibrate: () => true,
    });
    make(true);
    await manager.startOutgoing();
    await manager.hangup();

    expect(signals.some((s) => s.kind === 'bye')).toBe(true);
    expect(track.stopped).toBe(true);
    expect(FakePeerConnection.instances[0]!.closed).toBe(true);
    expect(states.at(-1)).toBe('ended');
  });

  it('a late ontrack after hangup does not restart the call', async () => {
    make(true);
    await manager.startOutgoing();
    await manager.hangup();
    manager.markActive();
    expect(states.at(-1)).toBe('ended');
    expect(states.filter((s) => s === 'active')).toHaveLength(0);
  });

  it('teardown is idempotent', async () => {
    make(true);
    await manager.startOutgoing();
    await manager.hangup();
    manager.dispose();
    expect(states.filter((s) => s === 'ended')).toHaveLength(1);
  });

  it('mute toggles the local track and signals the peer', async () => {
    const { track } = fakeMediaDevices();
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
      vibrate: () => true,
    });
    make(true);
    await manager.startOutgoing();
    manager.setMuted(true);
    expect(track.enabled).toBe(false);
    expect(signals.some((s) => s.kind === 'mute')).toBe(true);
    manager.setMuted(false);
    expect(track.enabled).toBe(true);
    expect(signals.some((s) => s.kind === 'unmute')).toBe(true);
  });

  it('ignores signalling after disposal', async () => {
    make(false);
    await manager.prepareIncoming();
    manager.dispose();
    await manager.handleSignal('offer', { sdp: 'offer-sdp', type: 'offer' });
    expect(signals.map((s) => s.kind)).not.toContain('answer');
  });
});

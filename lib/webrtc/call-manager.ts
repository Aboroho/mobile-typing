import type { CallSignalKind, IceServer } from '@mt/types';

export type CallClientState =
  | 'idle'
  | 'requesting-microphone'
  | 'connecting'
  | 'ringing'
  | 'active'
  | 'reconnecting'
  | 'ended';

export interface CallSignalPayload {
  sdp?: string;
  type?: string;
  candidate?: unknown;
  muted?: boolean;
}

export interface CallManagerOptions {
  callId: string;
  iceServers: IceServer[];
  isInitiator: boolean;
  /** Sends signalling payloads through the API (relayed over SSE to the peer). */
  sendSignal: (kind: CallSignalKind, payload: CallSignalPayload) => Promise<unknown>;
  onState: (state: CallClientState) => void;
  onRemoteMuted: (muted: boolean) => void;
  onDurationTick: (durationMs: number) => void;
  onDiagnostics: (info: { iceState: string | null; connectionState: string | null; turnUsed: boolean }) => void;
  onError: (error: Error) => void;
}

const RING_POLL_MS = 500;

/**
 * One-to-one audio call controller.
 *
 * Media never touches the server: only SDP and ICE candidates are relayed
 * through `/api/v1/calls/{id}/signal`. The manager owns the local microphone
 * track, exposes mute, ticks the call duration and reports ICE diagnostics so a
 * failed TURN negotiation is visible instead of silently producing silence.
 */
export class CallManager {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private durationTimer: number | null = null;
  private startedAt: number | null = null;
  private state: CallClientState = 'idle';
  private disposed = false;
  private turnUsed = false;

  constructor(private readonly options: CallManagerOptions) {}

  get currentState(): CallClientState {
    return this.state;
  }

  get durationMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  private setState(state: CallClientState): void {
    this.state = state;
    this.options.onState(state);
  }

  /** Initiator path: acquire the mic, create the peer connection and send an offer. */
  async startOutgoing(): Promise<void> {
    await this.acquireMicrophone();
    this.createPeerConnection();
    this.setState('connecting');
    const offer = await this.requirePc().createOffer({ offerToReceiveAudio: true });
    await this.requirePc().setLocalDescription(offer);
    await this.options.sendSignal('offer', { sdp: offer.sdp ?? '', type: offer.type });
    this.setState('ringing');
  }

  /** Recipient path: acquire the mic so the answer can include a send/recv track. */
  async prepareIncoming(): Promise<void> {
    await this.acquireMicrophone();
    this.createPeerConnection();
    this.setState('ringing');
  }

  async handleSignal(kind: CallSignalKind, payload: CallSignalPayload): Promise<void> {
    if (this.disposed) return;
    const pc = this.peerConnection;
    if (!pc) return;

    switch (kind) {
      case 'offer': {
        if (!payload.sdp) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.options.sendSignal('answer', { sdp: answer.sdp ?? '', type: answer.type });
        this.setState('connecting');
        break;
      }
      case 'answer': {
        if (!payload.sdp) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
        break;
      }
      case 'ice-candidate': {
        if (!payload.candidate) return;
        if (!this.remoteDescriptionSet) {
          this.queuedCandidates.push(payload.candidate as RTCIceCandidateInit);
          return;
        }
        await pc.addIceCandidate(payload.candidate as RTCIceCandidateInit).catch(() => undefined);
        break;
      }
      case 'mute':
        this.options.onRemoteMuted(true);
        break;
      case 'unmute':
        this.options.onRemoteMuted(false);
        break;
      case 'bye':
        this.teardown('ended');
        break;
      default:
        break;
    }
  }

  setMuted(muted: boolean): void {
    const track = this.localStream?.getAudioTracks()[0];
    if (track) track.enabled = !muted;
    void this.options.sendSignal(muted ? 'mute' : 'unmute', { muted });
  }

  /** Called when the call is answered; starts the visible duration counter. */
  markActive(): void {
    // A late `ontrack`/`connected` after hangup must not resurrect the timer.
    if (this.disposed || this.durationTimer !== null) return;
    this.startedAt = Date.now();
    this.setState('active');
    this.durationTimer = window.setInterval(() => {
      this.options.onDurationTick(this.durationMs);
    }, RING_POLL_MS * 2);
  }

  /** Graceful hangup: notify the peer, then release every resource. */
  async hangup(): Promise<void> {
    await this.options.sendSignal('bye', {}).catch(() => undefined);
    this.teardown('ended');
  }

  dispose(): void {
    this.teardown('ended');
  }

  private teardown(state: CallClientState): void {
    if (this.disposed) return;
    if (this.durationTimer !== null) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.peerConnection?.close();
    this.peerConnection = null;
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      // Remove the element too, otherwise every call leaves an <audio> node
      // behind in the document.
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.queuedCandidates = [];
    this.remoteDescriptionSet = false;
    this.disposed = true;
    this.setState(state);
  }

  private requirePc(): RTCPeerConnection {
    if (!this.peerConnection) throw new Error('peer connection is not initialised');
    return this.peerConnection;
  }

  private async acquireMicrophone(): Promise<void> {
    this.setState('requesting-microphone');
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : 'NotAllowedError';
      throw new Error(
        name === 'NotAllowedError'
          ? 'microphone permission was denied'
          : 'no microphone is available on this device',
      );
    }
  }

  private createPeerConnection(): void {
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers.length > 0 ? this.options.iceServers : undefined,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.peerConnection = pc;

    for (const track of this.localStream?.getTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.candidate;
      if (candidate.includes('relay')) this.turnUsed = true;
      void this.options
        .sendSignal('ice-candidate', { candidate: event.candidate.toJSON() })
        .catch(() => undefined);
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement('audio');
        this.remoteAudio.autoplay = true;
        // Required on iOS Safari: playback must be tied to a user gesture that
        // already happened (the accept button), and the element stays in the DOM.
        this.remoteAudio.setAttribute('playsinline', 'true');
        document.body.appendChild(this.remoteAudio);
      }
      this.remoteAudio.srcObject = stream;
      void this.remoteAudio.play().catch(() => undefined);
      if (!this.startedAt) this.markActive();
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      this.options.onDiagnostics({
        iceState,
        connectionState: pc.connectionState,
        turnUsed: this.turnUsed,
      });
      if (iceState === 'failed') {
        // Best effort recovery: restart ICE, which reuses the same call record.
        this.setState('reconnecting');
        void pc
          .createOffer({ iceRestart: true })
          .then((offer) => pc.setLocalDescription(offer))
          .then(() =>
            this.options.sendSignal('offer', {
              sdp: pc.localDescription?.sdp ?? '',
              type: pc.localDescription?.type ?? 'offer',
            }),
          )
          .catch(() => this.options.onError(new Error('connection failed')));
      }
      if (iceState === 'connected' && this.state !== 'active') this.markActive();
      if (iceState === 'closed') this.teardown('ended');
    };
  }

  private async flushCandidates(): Promise<void> {
    const pc = this.requirePc();
    const queued = this.queuedCandidates.splice(0, this.queuedCandidates.length);
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }
}

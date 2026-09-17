'use client';

import { Mic, MicOff, PhoneOff, PhoneIncoming, VolumeX } from 'lucide-react';
import { formatDuration } from '@mt/utils';
import { useCallStore, getCallDiagnostics } from '@/stores/call-store';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat-store';

/**
 * Incoming + active call UI.
 *
 * Ending a call from here always goes through the API, so no orphaned call
 * records are left behind when the page is hidden or the user triple-taps.
 */
export function CallOverlay() {
  const incoming = useCallStore((state) => state.incoming);
  const call = useCallStore((state) => state.call);
  const status = useCallStore((state) => state.state);
  const muted = useCallStore((state) => state.muted);
  const remoteMuted = useCallStore((state) => state.remoteMuted);
  const durationMs = useCallStore((state) => state.durationMs);
  const acceptIncoming = useCallStore((state) => state.acceptIncoming);
  const rejectIncoming = useCallStore((state) => state.rejectIncoming);
  const hangup = useCallStore((state) => state.hangup);
  const toggleMute = useCallStore((state) => state.toggleMute);
  const conversation = useChatStore((state) => state.activeConversation);

  if (!incoming && !call) return null;
  const diagnostics = getCallDiagnostics();
  const peerName = conversation?.otherUser.name ?? 'Unknown contact';

  const statusLabel = (() => {
    if (incoming) return 'Incoming audio call';
    switch (status) {
      case 'requesting-microphone':
        return 'Waiting for microphone…';
      case 'connecting':
        return 'Connecting…';
      case 'ringing':
        return 'Ringing…';
      case 'reconnecting':
        return 'Reconnecting…';
      case 'active':
        return formatDuration(durationMs);
      default:
        return 'Call';
    }
  })();

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-between bg-ink px-6 py-10 text-surface">
      <div className="flex flex-col items-center gap-3 pt-8 text-center">
        <span className="relative">
          {status === 'ringing' || incoming ? <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand" /> : null}
          <Avatar name={peerName} size="lg" />
        </span>
        <h2 className="text-xl font-semibold">{peerName}</h2>
        <p className="text-sm text-surface/70">{statusLabel}</p>
        {remoteMuted ? (
          <p className="flex items-center gap-1 text-xs text-surface/60">
            <VolumeX className="h-3.5 w-3.5" />
            The other person is muted
          </p>
        ) : null}
        {diagnostics?.iceState === 'failed' || diagnostics?.connectionState === 'failed' ? (
          <p className="rounded-lg bg-danger/20 px-3 py-1 text-xs">
            Connection failed — a TURN server may be required.
          </p>
        ) : null}
      </div>

      {incoming ? (
        <div className="flex w-full max-w-xs items-center justify-between">
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            onClick={() => void rejectIncoming()}
            aria-label="Decline call"
          >
            <PhoneOff className="h-5 w-5" />
            Decline
          </Button>
          <Button size="lg" className="flex-1" onClick={() => void acceptIncoming()} aria-label="Accept call">
            <PhoneIncoming className="h-5 w-5" />
            Accept
          </Button>
        </div>
      ) : (
        <div className="flex w-full max-w-xs items-center justify-center gap-4">
          <Button
            variant={muted ? 'danger' : 'secondary'}
            size="icon"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            className="h-14 w-14"
          >
            {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
          </Button>
          <Button
            variant="danger"
            size="icon"
            onClick={() => void hangup('hangup')}
            aria-label="End call"
            className="h-16 w-16"
          >
            <PhoneOff className="h-7 w-7" />
          </Button>
        </div>
      )}
    </div>
  );
}

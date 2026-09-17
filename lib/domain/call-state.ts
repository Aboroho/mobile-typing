import { CallStatus, type Call, type Timestamp } from '@mt/types';

const TERMINAL: readonly CallStatus[] = [
  CallStatus.Ended,
  CallStatus.Missed,
  CallStatus.Rejected,
  CallStatus.Cancelled,
  CallStatus.Failed,
];

export function isTerminalCallStatus(status: CallStatus): boolean {
  return TERMINAL.includes(status);
}

const CALL_TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  [CallStatus.Ringing]: [
    CallStatus.Accepted,
    CallStatus.Missed,
    CallStatus.Rejected,
    CallStatus.Cancelled,
    CallStatus.Failed,
  ],
  [CallStatus.Accepted]: [CallStatus.Active, CallStatus.Ended, CallStatus.Failed],
  [CallStatus.Active]: [CallStatus.Ended, CallStatus.Failed],
  [CallStatus.Ended]: [],
  [CallStatus.Missed]: [],
  [CallStatus.Rejected]: [],
  [CallStatus.Cancelled]: [],
  [CallStatus.Failed]: [],
};

export function canTransitionCall(from: CallStatus, to: CallStatus): boolean {
  return CALL_TRANSITIONS[from].includes(to);
}

export function assertCallTransition(from: CallStatus, to: CallStatus): void {
  if (!canTransitionCall(from, to)) {
    throw new Error(`illegal call transition ${from} -> ${to}`);
  }
}

export function computeCallDurationMs(
  answeredAt: Timestamp | null,
  endedAt: Timestamp,
): number | null {
  if (!answeredAt) return null;
  const duration = new Date(endedAt).getTime() - new Date(answeredAt).getTime();
  return duration > 0 ? duration : 0;
}

/** Whether the given user may act on the call at all. */
export function isCallParticipant(call: Pick<Call, 'initiatorId' | 'recipientId'>, userId: string): boolean {
  return call.initiatorId === userId || call.recipientId === userId;
}

export interface CallActorRoles {
  isInitiator: boolean;
  isRecipient: boolean;
}

export function callRoles(call: Pick<Call, 'initiatorId' | 'recipientId'>, userId: string): CallActorRoles {
  return {
    isInitiator: call.initiatorId === userId,
    isRecipient: call.recipientId === userId,
  };
}

/** Human readable summary used in the in-conversation call history. */
export function describeCall(call: Call, viewerId: string): string {
  const { isInitiator } = callRoles(call, viewerId);
  const duration = call.durationMs ? Math.round(call.durationMs / 1000) : 0;
  switch (call.status) {
    case CallStatus.Missed:
      return isInitiator ? 'No answer' : 'Missed audio call';
    case CallStatus.Rejected:
      return isInitiator ? 'Declined' : 'Declined audio call';
    case CallStatus.Cancelled:
      return isInitiator ? 'Cancelled' : 'Cancelled call';
    case CallStatus.Failed:
      return 'Call failed';
    case CallStatus.Ringing:
      return isInitiator ? 'Calling…' : 'Incoming audio call';
    default:
      return duration > 0 ? `Audio call · ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : 'Audio call';
  }
}

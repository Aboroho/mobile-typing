import type { EntityTimestamps, Timestamp } from './common';

export const CallType = {
  Audio: 'audio',
} as const;
export type CallType = (typeof CallType)[keyof typeof CallType];

export const CallStatus = {
  Ringing: 'ringing',
  Accepted: 'accepted',
  Active: 'active',
  Ended: 'ended',
  Missed: 'missed',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
  Failed: 'failed',
} as const;
export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];

export const CallEndReason = {
  Hangup: 'hangup',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
  Timeout: 'timeout',
  PrivacyLock: 'privacy_lock',
  Network: 'network',
  Error: 'error',
} as const;
export type CallEndReason = (typeof CallEndReason)[keyof typeof CallEndReason];

export const CallSignalKind = {
  Offer: 'offer',
  Answer: 'answer',
  IceCandidate: 'ice-candidate',
  Mute: 'mute',
  Unmute: 'unmute',
  Bye: 'bye',
} as const;
export type CallSignalKind = (typeof CallSignalKind)[keyof typeof CallSignalKind];

export interface Call extends EntityTimestamps {
  id: string;
  conversationId: string;
  initiatorId: string;
  recipientId: string;
  type: CallType;
  status: CallStatus;
  startedAt: Timestamp | null;
  answeredAt: Timestamp | null;
  endedAt: Timestamp | null;
  durationMs: number | null;
  endReason: CallEndReason | null;
  /** WebRTC diagnostics kept for troubleshooting; no media is stored. */
  diagnostics: {
    iceState: string | null;
    connectionState: string | null;
    turnUsed: boolean | null;
  };
}

export type CallView = Omit<Call, 'diagnostics'>;

export interface CallSignal {
  id: string;
  callId: string;
  fromUserId: string;
  toUserId: string;
  kind: CallSignalKind;
  payload: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

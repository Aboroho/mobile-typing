import { describe, expect, it } from 'vitest';
import { CallStatus } from '@mt/types';
import {
  assertCallTransition,
  callRoles,
  canTransitionCall,
  computeCallDurationMs,
  isCallParticipant,
  isTerminalCallStatus,
} from '@/lib/domain/call-state';

describe('call state machine', () => {
  it('follows the documented happy path', () => {
    expect(canTransitionCall(CallStatus.Ringing, CallStatus.Accepted)).toBe(true);
    expect(canTransitionCall(CallStatus.Accepted, CallStatus.Active)).toBe(true);
    expect(canTransitionCall(CallStatus.Active, CallStatus.Ended)).toBe(true);
  });

  it('covers ring-out, rejection, cancellation and failure', () => {
    expect(canTransitionCall(CallStatus.Ringing, CallStatus.Missed)).toBe(true);
    expect(canTransitionCall(CallStatus.Ringing, CallStatus.Rejected)).toBe(true);
    expect(canTransitionCall(CallStatus.Ringing, CallStatus.Cancelled)).toBe(true);
    expect(canTransitionCall(CallStatus.Active, CallStatus.Failed)).toBe(true);
  });

  it('never leaves a terminal state', () => {
    for (const status of [CallStatus.Ended, CallStatus.Missed, CallStatus.Rejected, CallStatus.Cancelled, CallStatus.Failed]) {
      expect(isTerminalCallStatus(status)).toBe(true);
      expect(canTransitionCall(status, CallStatus.Active)).toBe(false);
      expect(canTransitionCall(status, CallStatus.Ringing)).toBe(false);
    }
    expect(isTerminalCallStatus(CallStatus.Ringing)).toBe(false);
  });

  it('throws on an illegal transition instead of silently corrupting a call', () => {
    expect(() => assertCallTransition(CallStatus.Ended, CallStatus.Active)).toThrow(/illegal call transition/);
    expect(() => assertCallTransition(CallStatus.Ringing, CallStatus.Accepted)).not.toThrow();
  });
});

describe('call participants', () => {
  const call = { initiatorId: 'alice', recipientId: 'bob' };

  it('identifies both sides and nobody else', () => {
    expect(isCallParticipant(call, 'alice')).toBe(true);
    expect(isCallParticipant(call, 'bob')).toBe(true);
    expect(isCallParticipant(call, 'carol')).toBe(false);
  });

  it('reports the role, which decides who may cancel versus reject', () => {
    expect(callRoles(call, 'alice')).toEqual({ isInitiator: true, isRecipient: false });
    expect(callRoles(call, 'bob')).toEqual({ isInitiator: false, isRecipient: true });
  });
});

it('computes duration only for answered calls', () => {
  expect(computeCallDurationMs(null, '2026-01-01T00:01:00.000Z')).toBeNull();
  expect(computeCallDurationMs('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:30.000Z')).toBe(90_000);
  expect(computeCallDurationMs('2026-01-01T00:02:00.000Z', '2026-01-01T00:01:00.000Z')).toBe(0);
});

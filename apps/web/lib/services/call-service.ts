import { AppError, assertCallTransition, canTransitionCall, computeCallDurationMs } from '@mt/domain';
import { CALL_RING_TIMEOUT_MS, type Call, type CallEndReason, type CallSignalKind, type CallView, type Cursor, type IceServer } from '@mt/types';
import { newId, nowIso } from '@mt/utils';
import type { CallCreateResponse } from '@mt/api-client';
import { getData, type UserRecord } from '../data';
import { env } from '../env';
import { publish, topics } from '../realtime/bus';
import { logger } from '../logger';
import { otherParticipant } from '@mt/domain';
import { requireParticipant } from './conversation-service';
import { sendMessage } from './message-service';

/** ICE servers come from the environment; TURN is only added when complete. */
export function iceServers(): IceServer[] {
  const config = env();
  const servers: IceServer[] = [
    { urls: config.STUN_SERVER_URL.split(',').map((url) => url.trim()).filter(Boolean) },
  ];
  if (config.TURN_SERVER_URL && config.TURN_SERVER_USERNAME && config.TURN_SERVER_CREDENTIAL) {
    servers.push({
      urls: config.TURN_SERVER_URL.split(',').map((url) => url.trim()).filter(Boolean),
      username: config.TURN_SERVER_USERNAME,
      credential: config.TURN_SERVER_CREDENTIAL,
    });
  }
  return servers;
}

export function toCallView(call: Call): CallView {
  const { diagnostics: _diagnostics, ...view } = call;
  void _diagnostics;
  return view;
}

export async function getActiveCallForUser(userId: string): Promise<Call | null> {
  const data = await getData();
  const ringing = await data.calls.findRingingForUser(userId);
  if (ringing) return ringing;
  const conversations = await data.conversations.list({ userId, limit: 25 });
  for (const conversation of conversations.items) {
    const active = await data.calls.findActiveForConversation(conversation.id);
    if (active && (active.initiatorId === userId || active.recipientId === userId)) return active;
  }
  return null;
}

/** Marks ringing calls that were never answered as missed. */
export async function expireStaleCalls(userId: string): Promise<void> {
  const data = await getData();
  const ringing = await data.calls.findRingingForUser(userId);
  if (!ringing) return;
  const age = Date.now() - new Date(ringing.createdAt).getTime();
  if (age < CALL_RING_TIMEOUT_MS) return;
  await transitionCall(ringing, 'missed', { reason: 'timeout', actorId: ringing.initiatorId });
}

export async function createCall(input: {
  actor: UserRecord;
  conversationId: string;
}): Promise<CallCreateResponse> {
  const data = await getData();
  const conversation = await requireParticipant(input.conversationId, input.actor.id);
  const recipientId = otherParticipant(conversation, input.actor.id);

  const existing = await data.calls.findActiveForConversation(input.conversationId);
  if (existing) {
    throw AppError.conflict('a call is already in progress in this conversation', {
      callId: existing.id,
    });
  }

  const now = nowIso();
  const call: Call = {
    id: newId('call'),
    conversationId: input.conversationId,
    initiatorId: input.actor.id,
    recipientId,
    type: 'audio',
    status: 'ringing',
    startedAt: now,
    answeredAt: null,
    endedAt: null,
    durationMs: null,
    endReason: null,
    diagnostics: { iceState: null, connectionState: null, turnUsed: null },
    createdAt: now,
    updatedAt: now,
  };
  const created = await data.calls.create(call);

  publish(topics.userCalls(recipientId), 'call.incoming', { call: toCallView(created) });
  publish(topics.userCalls(input.actor.id), 'call.outgoing', { call: toCallView(created) });
  logger.info('call.created', { callId: created.id, conversationId: input.conversationId });

  return { call: created, iceServers: iceServers() };
}

interface TransitionOptions {
  reason: CallEndReason;
  actorId: string;
  durationMs?: number;
}

async function transitionCall(call: Call, status: Call['status'], options: TransitionOptions): Promise<Call> {
  if (!canTransitionCall(call.status, status)) {
    throw new AppError('PRECONDITION_FAILED', `call is already ${call.status}`);
  }
  const data = await getData();
  const now = nowIso();
  const ended = status !== 'ringing' && status !== 'accepted' && status !== 'active';
  const answeredAt = status === 'accepted' ? now : call.answeredAt;
  const durationMs = ended ? computeCallDurationMs(answeredAt, now) : call.durationMs;

  const updated = await data.calls.update(call.id, {
    status,
    answeredAt,
    endedAt: ended ? now : null,
    durationMs: options.durationMs ?? durationMs,
    endReason: ended ? options.reason : null,
  });
  if (!updated) throw AppError.notFound('call not found');

  publish(topics.call(call.id), 'call.state', { call: toCallView(updated) });
  publish(topics.userCalls(call.initiatorId), 'call.state', { call: toCallView(updated) });
  publish(topics.userCalls(call.recipientId), 'call.state', { call: toCallView(updated) });

  if (ended) await recordCallMessage(updated);
  return updated;
}

/** Writes the call record into the conversation so both sides keep a history. */
async function recordCallMessage(call: Call): Promise<void> {
  const data = await getData();
  const initiator = await data.users.getById(call.initiatorId);
  if (!initiator) return;
  await sendMessage({
    actor: initiator,
    conversationId: call.conversationId,
    type: 'call',
    clientMessageId: `call_${call.id}`,
    call: toCallView(call),
  }).catch((error) => logger.warn('call.message_failed', { error: String(error) }));
}

export async function acceptCall(input: { actor: UserRecord; callId: string }): Promise<Call> {
  const data = await getData();
  const call = await requireCallParticipant(input.callId, input.actor.id);
  if (call.recipientId !== input.actor.id) throw AppError.forbidden('only the recipient can accept');
  assertCallTransition(call.status, 'accepted');
  const updated = await transitionCall(call, 'accepted', { reason: 'hangup', actorId: input.actor.id });
  await data.calls.update(call.id, { answeredAt: updated.answeredAt ?? nowIso() });
  publish(topics.call(call.id), 'call.accepted', { callId: call.id, by: input.actor.id });
  return updated;
}

export async function rejectCall(input: {
  actor: UserRecord;
  callId: string;
  reason?: string;
}): Promise<Call> {
  const call = await requireCallParticipant(input.callId, input.actor.id);
  if (call.recipientId !== input.actor.id) throw AppError.forbidden('only the recipient can decline');
  return transitionCall(call, 'rejected', { reason: 'rejected', actorId: input.actor.id });
}

/**
 * Ends a call. When the initiator ends a still ringing call it is recorded as a
 * cancellation; when the page is hidden or the user triple-taps, the client
 * passes `privacy_lock` so the reason is explicit in the history.
 */
export async function endCall(input: {
  actor: UserRecord;
  callId: string;
  reason: CallEndReason;
  durationMs?: number;
}): Promise<Call> {
  const call = await requireCallParticipant(input.callId, input.actor.id);
  if (call.status === 'ringing' && call.initiatorId === input.actor.id && input.reason === 'hangup') {
    return transitionCall(call, 'cancelled', { reason: 'cancelled', actorId: input.actor.id });
  }
  if (call.status === 'ringing') {
    return transitionCall(call, 'missed', { reason: input.reason, actorId: input.actor.id });
  }
  return transitionCall(call, 'ended', {
    reason: input.reason,
    actorId: input.actor.id,
    durationMs: input.durationMs,
  });
}

export async function signalCall(input: {
  actor: UserRecord;
  callId: string;
  kind: CallSignalKind;
  payload: Record<string, unknown>;
}): Promise<void> {
  const call = await requireCallParticipant(input.callId, input.actor.id);
  if (['ended', 'missed', 'rejected', 'cancelled', 'failed'].includes(call.status)) {
    throw new AppError('PRECONDITION_FAILED', 'the call has already finished');
  }
  const peerId = call.initiatorId === input.actor.id ? call.recipientId : call.initiatorId;
  publish(topics.call(input.callId), `signal.${input.kind}`, {
    callId: input.callId,
    fromUserId: input.actor.id,
    toUserId: peerId,
    kind: input.kind,
    payload: input.payload,
  });
}

export async function updateCallDiagnostics(input: {
  actor: UserRecord;
  callId: string;
  iceState: string | null;
  connectionState: string | null;
  turnUsed: boolean | null;
}): Promise<void> {
  await requireCallParticipant(input.callId, input.actor.id);
  const data = await getData();
  await data.calls.update(input.callId, {
    diagnostics: { iceState: input.iceState, connectionState: input.connectionState, turnUsed: input.turnUsed },
  });
}

export async function listCalls(input: {
  userId: string;
  conversationId?: string;
  limit: number;
  cursor?: string | null;
}): Promise<Cursor<CallView>> {
  const data = await getData();
  if (input.conversationId) await requireParticipant(input.conversationId, input.userId);
  const page = await data.calls.list({
    conversationId: input.conversationId,
    userId: input.userId,
    limit: input.limit,
    cursor: input.cursor,
  });
  return { ...page, items: page.items.map(toCallView) };
}

export async function getCallHistoryForConversation(conversationId: string, viewerId: string): Promise<CallView[]> {
  await requireParticipant(conversationId, viewerId);
  const data = await getData();
  const page = await data.calls.list({ conversationId, limit: 50 });
  return page.items.map(toCallView);
}

async function requireCallParticipant(callId: string, userId: string): Promise<Call> {
  const data = await getData();
  const call = await data.calls.getById(callId);
  if (!call) throw AppError.notFound('call not found');
  if (call.initiatorId !== userId && call.recipientId !== userId) {
    throw AppError.notFound('call not found');
  }
  return call;
}

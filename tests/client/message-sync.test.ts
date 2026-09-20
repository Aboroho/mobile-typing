import { describe, expect, it } from 'vitest';
import type { DeliveryState, MessageForUser, Timestamp } from '@mt/types';
import {
  applyDelivery,
  dedupeMessages,
  deliveryRank,
  isOptimistic,
  markAllFailed,
  markFailed,
  mergePage,
  pickCanonical,
  sameMessage,
  sortByTime,
  upsertMessage,
} from '@/lib/client/message-sync';

let counter = 0;

function message(overrides: Partial<MessageForUser> = {}): MessageForUser {
  counter += 1;
  const at = new Date(1_700_000_000_000 + counter * 1000).toISOString() as Timestamp;
  return {
    id: `m_${counter}`,
    conversationId: 'c1',
    senderId: 'u_peer',
    type: 'text',
    text: `message ${counter}`,
    media: null,
    call: null,
    replyTo: null,
    deliveryState: 'sent',
    deliveredAt: null,
    readBy: [],
    readAt: null,
    edited: false,
    editedAt: null,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    clientMessageId: null,
    expiresAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as MessageForUser;
}

function optimistic(clientMessageId: string, text = 'hello'): MessageForUser {
  const at = new Date(1_700_000_000_000).toISOString() as Timestamp;
  return message({
    id: clientMessageId,
    senderId: 'u_me',
    text,
    clientMessageId,
    deliveryState: 'sending',
    createdAt: at,
    updatedAt: at,
  });
}

describe('message identity', () => {
  it('matches on the canonical server id', () => {
    expect(sameMessage(message({ id: 'm1' }), message({ id: 'm1' }))).toBe(true);
  });

  it('matches an optimistic copy to its canonical record via clientMessageId', () => {
    const local = optimistic('cmsg_1');
    const canonical = message({ id: 'm_server', clientMessageId: 'cmsg_1' });
    expect(sameMessage(local, canonical)).toBe(true);
  });

  it('does not match different messages that merely share a conversation', () => {
    expect(sameMessage(message({ id: 'a' }), message({ id: 'b' }))).toBe(false);
  });

  it('recognises optimistic copies', () => {
    expect(isOptimistic(optimistic('cmsg_1'))).toBe(true);
    expect(isOptimistic(message())).toBe(false);
  });
});

describe('upsertMessage — the duplicate bug', () => {
  it('optimistic insert then REST response replaces in place (no duplicate)', () => {
    const local = optimistic('cmsg_1');
    const canonical = message({ id: 'm_1', clientMessageId: 'cmsg_1' });
    const result = upsertMessage([local], canonical);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('m_1');
    expect(result[0]?.deliveryState).toBe('sent');
  });

  it('optimistic insert then WebSocket event replaces in place (no duplicate)', () => {
    const local = optimistic('cmsg_2');
    const event = message({ id: 'm_2', clientMessageId: 'cmsg_2' });
    const result = upsertMessage([local], event);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('m_2');
  });

  it('WebSocket event that wins the race is merged when the REST response lands later', () => {
    // The event arrives first, so the list holds the canonical record already;
    // the REST response for the same logical message must not add a row.
    const event = message({ id: 'm_3', clientMessageId: 'cmsg_3' });
    const restResponse = message({ id: 'm_3', clientMessageId: 'cmsg_3' });
    const result = upsertMessage([event], restResponse);
    expect(result).toHaveLength(1);
  });

  it('the same WebSocket event delivered twice is applied once', () => {
    const event = message({ id: 'm_4', clientMessageId: 'cmsg_4' });
    const once = upsertMessage([], event);
    const twice = upsertMessage(once, { ...event });
    expect(twice).toHaveLength(1);
  });

  it('keeps unrelated messages in time order', () => {
    const a = message({ createdAt: '2024-01-01T00:00:00.000Z' });
    const b = message({ createdAt: '2024-01-02T00:00:00.000Z' });
    const result = upsertMessage([b], a);
    expect(result.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it('never rolls a receipt back when an older copy arrives late', () => {
    const read = message({ id: 'm_5', deliveryState: 'read', readBy: ['u_peer'] });
    const staleSent = message({ id: 'm_5', deliveryState: 'sent', readBy: [] });
    const result = upsertMessage([read], staleSent);
    expect(result).toHaveLength(1);
    expect(result[0]?.deliveryState).toBe('read');
  });
});

describe('mergePage — pagination plus live updates', () => {
  it('a paginated fetch does not duplicate messages received live', () => {
    const live = message({ id: 'm_live', clientMessageId: 'cmsg_live' });
    const page = [message({ id: 'm_old' }), { ...live }];
    const result = mergePage([live], page);
    expect(result).toHaveLength(2);
    expect(result.filter((m) => m.id === 'm_live')).toHaveLength(1);
  });

  it('an optimistic message survives a paginated fetch', () => {
    const local = optimistic('cmsg_p');
    const page = [message({ id: 'm_p1' })];
    const result = mergePage([local], page);
    expect(result).toHaveLength(2);
    expect(result.some((m) => m.deliveryState === 'sending')).toBe(true);
  });
});

describe('dedupeMessages', () => {
  it('collapses an optimistic copy and its canonical record', () => {
    const local = optimistic('cmsg_d');
    const canonical = message({ id: 'm_d', clientMessageId: 'cmsg_d' });
    const result = dedupeMessages([local, canonical]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('m_d');
  });

  it('prefers the canonical record over the optimistic one', () => {
    const local = optimistic('cmsg_e');
    const canonical = message({ id: 'm_e', clientMessageId: 'cmsg_e' });
    expect(pickCanonical(local, canonical).id).toBe('m_e');
    expect(pickCanonical(canonical, local).id).toBe('m_e');
  });
});

describe('delivery receipts', () => {
  it('advances delivered then read', () => {
    const sent = message({ id: 'm_r', deliveryState: 'sent' });
    const delivered = applyDelivery([sent], ['m_r'], 'delivered');
    expect(delivered[0]?.deliveryState).toBe('delivered');
    const read = applyDelivery(delivered, ['m_r'], 'read');
    expect(read[0]?.deliveryState).toBe('read');
  });

  it('ignores ids that are not in the list', () => {
    const list = [message({ id: 'm_s' })];
    expect(applyDelivery(list, ['nope'], 'read')).toBe(list);
  });

  it('marks a pending message failed without dropping it', () => {
    const local = optimistic('cmsg_f');
    const failed = markFailed([local], 'cmsg_f');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.deliveryState).toBe('failed');
    expect(failed[0]?.clientMessageId).toBe('cmsg_f');
  });

  it('marks everything in flight as failed when the transport dies', () => {
    const list = [optimistic('cmsg_g'), message({ id: 'm_ok' })];
    const result = markAllFailed(list);
    expect(result.find((m) => m.clientMessageId === 'cmsg_g')?.deliveryState).toBe('failed');
    expect(result.find((m) => m.id === 'm_ok')?.deliveryState).toBe('sent');
  });

  it('ranks delivery states monotonically', () => {
    const order: DeliveryState[] = ['sending', 'sent', 'delivered', 'read'];
    const ranks = order.map((state) => deliveryRank(state));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('ordering', () => {
  it('is stable for identical timestamps', () => {
    const at = '2024-05-05T00:00:00.000Z' as Timestamp;
    const a = message({ id: 'aaa', createdAt: at });
    const b = message({ id: 'bbb', createdAt: at });
    expect(sortByTime([b, a]).map((m) => m.id)).toEqual(['aaa', 'bbb']);
  });
});

import { describe, expect, it } from 'vitest';
import type { MessageForUser } from '@mt/types';
import {
  applyDeliveryState,
  applyOptimistic,
  applyReadWatermark,
  markSendFailed,
  mergeMessage,
  mergeMessages,
  messageKey,
  newestCanonical,
  oldestCanonical,
  optimisticCreatedAt,
  pendingDeliveryIds,
  reconcileMessage,
  sortMessages,
} from '@mt/domain';

const ME = 'u_me';
const PEER = 'u_peer';

function message(overrides: Partial<MessageForUser> & { id: string }): MessageForUser {
  const now = '2026-01-01T10:00:00.000Z';
  return {
    conversationId: 'c_1',
    senderId: ME,
    type: 'text',
    text: 'hello',
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function optimistic(clientMessageId: string, createdAt: string, text = 'hello'): MessageForUser {
  return message({
    id: clientMessageId,
    clientMessageId,
    deliveryState: 'sending',
    text,
    createdAt,
    updatedAt: createdAt,
  });
}

function canonical(id: string, clientMessageId: string, createdAt: string, text = 'hello'): MessageForUser {
  return message({ id, clientMessageId, deliveryState: 'sent', text, createdAt, updatedAt: createdAt });
}

const ids = (list: MessageForUser[]) => list.map((item) => item.id);

describe('optimistic message followed by the realtime event', () => {
  it('replaces the placeholder in place instead of appending the canonical copy', () => {
    const placeholder = optimistic('cmsg_a', '2026-01-01T10:00:00.000Z');
    let list = applyOptimistic([], placeholder);
    expect(list).toHaveLength(1);

    // The stream publishes before the HTTP response is written.
    const fromStream = canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.250Z');
    list = mergeMessage(list, fromStream);

    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('m_1');
    expect(list[0]!.deliveryState).toBe('sent');
    expect(messageKey(list[0]!)).toBe('cmsg_a');
  });

  it('keeps a single row when the HTTP response arrives after the stream event', () => {
    const placeholder = optimistic('cmsg_a', '2026-01-01T10:00:00.000Z');
    const fromStream = canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.250Z');
    const fromResponse = canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.250Z');

    let list = applyOptimistic([], placeholder);
    list = mergeMessage(list, fromStream);
    const before = list;
    list = mergeMessage(list, fromResponse);

    expect(list).toHaveLength(1);
    // Identical canonical content is a no-op: same array reference, no re-render.
    expect(list).toBe(before);
  });

  it('keeps a single row when the HTTP response arrives before the stream event', () => {
    const placeholder = optimistic('cmsg_a', '2026-01-01T10:00:00.000Z');
    const fromResponse = canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.250Z');
    const fromStream = canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.250Z');

    let list = applyOptimistic([], placeholder);
    list = mergeMessage(list, fromResponse);
    list = mergeMessage(list, fromStream);

    expect(ids(list)).toEqual(['m_1']);
  });
});

describe('successful send reconciliation', () => {
  it('replaces the temporary id with the canonical id and preserves the logical identity', () => {
    const placeholder = optimistic('cmsg_a', '2026-01-01T10:00:00.000Z');
    const list = mergeMessage([placeholder], canonical('m_9', 'cmsg_a', '2026-01-01T10:00:00.100Z'));
    expect(list[0]!.id).toBe('m_9');
    expect(list[0]!.clientMessageId).toBe('cmsg_a');
    expect(messageKey(placeholder)).toBe(messageKey(list[0]!));
  });

  it('adopts the server timestamp so ordering follows the server', () => {
    const older = canonical('m_1', 'cmsg_old', '2026-01-01T10:00:00.000Z');
    // Device clock is ahead: the placeholder claims a time later than the peer's reply.
    const placeholder = optimistic('cmsg_a', '2026-01-01T10:00:05.000Z');
    const peerReply = message({ id: 'm_2', senderId: PEER, createdAt: '2026-01-01T10:00:02.000Z', updatedAt: '2026-01-01T10:00:02.000Z' });

    let list = mergeMessages([older], [peerReply]);
    list = applyOptimistic(list, placeholder);
    expect(ids(list)).toEqual(['m_1', 'm_2', 'cmsg_a']);

    list = mergeMessage(list, canonical('m_3', 'cmsg_a', '2026-01-01T10:00:01.000Z'));
    expect(ids(list)).toEqual(['m_1', 'm_3', 'm_2']);
  });
});

describe('failed send', () => {
  it('marks a pending placeholder as failed', () => {
    const list = markSendFailed([optimistic('cmsg_a', '2026-01-01T10:00:00.000Z')], 'cmsg_a');
    expect(list[0]!.deliveryState).toBe('failed');
  });

  it('ignores a late failure when the stream already confirmed the message', () => {
    // Request timed out client side after the server persisted the message.
    let list = applyOptimistic([], optimistic('cmsg_a', '2026-01-01T10:00:00.000Z'));
    list = mergeMessage(list, canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.100Z'));
    const before = list;
    list = markSendFailed(list, 'cmsg_a');
    expect(list).toBe(before);
    expect(list[0]!.deliveryState).toBe('sent');
  });

  it('never lets a placeholder overwrite a canonical message', () => {
    const confirmed = canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.100Z');
    const list = mergeMessage([confirmed], optimistic('cmsg_a', '2026-01-01T10:00:00.000Z'));
    expect(list).toEqual([confirmed]);
  });
});

describe('retry after failure', () => {
  it('re-arms the same row with the same client id rather than adding a second one', () => {
    let list = applyOptimistic([], optimistic('cmsg_a', '2026-01-01T10:00:00.000Z'));
    list = markSendFailed(list, 'cmsg_a');
    list = applyOptimistic(list, optimistic('cmsg_a', '2026-01-01T10:00:09.000Z'));
    expect(list).toHaveLength(1);
    expect(list[0]!.deliveryState).toBe('sending');
    expect(list[0]!.clientMessageId).toBe('cmsg_a');
  });

  it('reconciles the retried message with the canonical copy exactly once', () => {
    let list = applyOptimistic([], optimistic('cmsg_a', '2026-01-01T10:00:00.000Z'));
    list = markSendFailed(list, 'cmsg_a');
    list = applyOptimistic(list, optimistic('cmsg_a', '2026-01-01T10:00:09.000Z'));
    // Server had actually stored the first attempt: idempotent response + stream.
    list = mergeMessage(list, canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.400Z'));
    list = mergeMessage(list, canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.400Z'));
    expect(ids(list)).toEqual(['m_1']);
  });

  it('does not re-arm a row that the server has already confirmed', () => {
    let list = mergeMessage([], canonical('m_1', 'cmsg_a', '2026-01-01T10:00:00.400Z'));
    const before = list;
    list = applyOptimistic(list, optimistic('cmsg_a', '2026-01-01T10:00:09.000Z'));
    expect(list).toBe(before);
  });
});

describe('listener reconnection', () => {
  it('merges the complete catch-up set without duplicating anything already present', () => {
    const existing = [
      canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'),
      message({ id: 'm_2', senderId: PEER, createdAt: '2026-01-01T10:00:01.000Z', updatedAt: '2026-01-01T10:00:01.000Z' }),
    ];
    const catchUp = [
      canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'),
      message({ id: 'm_2', senderId: PEER, createdAt: '2026-01-01T10:00:01.000Z', updatedAt: '2026-01-01T10:00:01.000Z' }),
      message({ id: 'm_3', senderId: PEER, createdAt: '2026-01-01T10:00:02.000Z', updatedAt: '2026-01-01T10:00:02.000Z' }),
    ];
    const merged = mergeMessages(existing, catchUp);
    expect(ids(merged)).toEqual(['m_1', 'm_2', 'm_3']);
  });

  it('keeps unsent local messages across a reconnect refresh', () => {
    const pending = optimistic('cmsg_p', '2026-01-01T10:00:05.000Z');
    const failed = { ...optimistic('cmsg_f', '2026-01-01T10:00:06.000Z'), deliveryState: 'failed' as const };
    const list = mergeMessages([canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'), pending, failed], [
      canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'),
      message({ id: 'm_2', senderId: PEER, createdAt: '2026-01-01T10:00:01.000Z', updatedAt: '2026-01-01T10:00:01.000Z' }),
    ]);
    expect(ids(list)).toEqual(['m_1', 'm_2', 'cmsg_p', 'cmsg_f']);
    expect(list[3]!.deliveryState).toBe('failed');
  });

  it('picks up delivery states that changed while disconnected', () => {
    const list = mergeMessages(
      [canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z')],
      [{ ...canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'), deliveryState: 'read', updatedAt: '2026-01-01T10:00:03.000Z' }],
    );
    expect(list[0]!.deliveryState).toBe('read');
  });
});

describe('multiple snapshots containing the same message', () => {
  it('is idempotent for repeated identical events', () => {
    const event = canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z');
    let list = mergeMessage([], event);
    const once = list;
    list = mergeMessage(list, { ...event });
    list = mergeMessage(list, { ...event });
    expect(list).toBe(once);
    expect(list).toHaveLength(1);
  });

  it('never downgrades a delivery state from a stale, out-of-order event', () => {
    const read = { ...canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'), deliveryState: 'read' as const, updatedAt: '2026-01-01T10:00:05.000Z' };
    const staleSent = canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z');
    const list = mergeMessage([read], staleSent);
    expect(list[0]!.deliveryState).toBe('read');
  });

  it('keeps deletion sticky and takes the newest edit', () => {
    const base = canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z');
    const edited = { ...base, text: 'edited', edited: true, updatedAt: '2026-01-01T10:00:02.000Z' };
    const deleted = { ...base, text: null, deleted: true, updatedAt: '2026-01-01T10:00:03.000Z' };

    let list = mergeMessage([base], deleted);
    list = mergeMessage(list, edited); // stale edit after deletion
    expect(list[0]!.deleted).toBe(true);
    expect(list[0]!.text).toBeNull();

    const edits = mergeMessage([base], edited);
    expect(edits[0]!.text).toBe('edited');
  });
});

describe('rapid consecutive messages', () => {
  it('keeps typing order while all of them are pending and after they resolve in any order', () => {
    const t0 = Date.parse('2026-01-01T10:00:00.000Z');
    let list: MessageForUser[] = [];
    const a = optimistic('cmsg_a', optimisticCreatedAt(list, t0), 'a');
    list = applyOptimistic(list, a);
    const b = optimistic('cmsg_b', optimisticCreatedAt(list, t0), 'b'); // same instant on the device
    list = applyOptimistic(list, b);
    const c = optimistic('cmsg_c', optimisticCreatedAt(list, t0), 'c');
    list = applyOptimistic(list, c);
    expect(list.map((item) => item.text)).toEqual(['a', 'b', 'c']);

    // Server confirms them out of order (c first).
    list = mergeMessage(list, canonical('m_c', 'cmsg_c', '2026-01-01T10:00:00.300Z', 'c'));
    list = mergeMessage(list, canonical('m_a', 'cmsg_a', '2026-01-01T10:00:00.100Z', 'a'));
    list = mergeMessage(list, canonical('m_b', 'cmsg_b', '2026-01-01T10:00:00.200Z', 'b'));
    expect(list.map((item) => item.text)).toEqual(['a', 'b', 'c']);
    expect(ids(list)).toEqual(['m_a', 'm_b', 'm_c']);
  });

  it('places an optimistic message after the newest one even when the device clock trails', () => {
    const list = [canonical('m_1', 'cmsg_1', '2026-01-01T10:00:10.000Z')];
    const createdAt = optimisticCreatedAt(list, Date.parse('2026-01-01T10:00:00.000Z'));
    expect(createdAt).toBe('2026-01-01T10:00:10.001Z');
  });
});

describe('two browser tabs sending messages', () => {
  it('shows a message sent from another tab exactly once, no matter how often the stream repeats it', () => {
    // This tab has no placeholder for a message the same user sent elsewhere.
    const fromOtherTab = canonical('m_1', 'cmsg_other_tab', '2026-01-01T10:00:00.000Z');
    let list = mergeMessage([], fromOtherTab);
    list = mergeMessage(list, fromOtherTab); // reconnect catch-up repeats it
    list = mergeMessages(list, [fromOtherTab]); // page refresh repeats it again
    expect(ids(list)).toEqual(['m_1']);
  });

  it('keeps both tabs consistent when each tab has its own pending message', () => {
    let tabA = applyOptimistic([], optimistic('cmsg_a', '2026-01-01T10:00:00.000Z', 'from A'));
    let tabB = applyOptimistic([], optimistic('cmsg_b', '2026-01-01T10:00:00.050Z', 'from B'));

    const canonA = canonical('m_a', 'cmsg_a', '2026-01-01T10:00:00.100Z', 'from A');
    const canonB = canonical('m_b', 'cmsg_b', '2026-01-01T10:00:00.150Z', 'from B');
    for (const event of [canonA, canonB]) {
      tabA = mergeMessage(tabA, event);
      tabB = mergeMessage(tabB, event);
    }
    expect(ids(tabA)).toEqual(['m_a', 'm_b']);
    expect(ids(tabB)).toEqual(['m_a', 'm_b']);
  });
});

describe('pagination combined with realtime updates', () => {
  it('prepends an older page without disturbing or duplicating newer messages', () => {
    const live = [
      message({ id: 'm_30', senderId: PEER, createdAt: '2026-01-01T10:00:30.000Z', updatedAt: '2026-01-01T10:00:30.000Z' }),
      optimistic('cmsg_new', '2026-01-01T10:00:31.000Z'),
    ];
    const olderPage = [
      message({ id: 'm_28', createdAt: '2026-01-01T10:00:28.000Z', updatedAt: '2026-01-01T10:00:28.000Z' }),
      message({ id: 'm_29', createdAt: '2026-01-01T10:00:29.000Z', updatedAt: '2026-01-01T10:00:29.000Z' }),
      // Overlap with what is already loaded.
      message({ id: 'm_30', senderId: PEER, createdAt: '2026-01-01T10:00:30.000Z', updatedAt: '2026-01-01T10:00:30.000Z' }),
    ];
    // A realtime message lands while the page request is in flight.
    let list = mergeMessage(live, message({ id: 'm_31', senderId: PEER, createdAt: '2026-01-01T10:00:32.000Z', updatedAt: '2026-01-01T10:00:32.000Z' }));
    list = mergeMessages(list, olderPage);
    expect(ids(list)).toEqual(['m_28', 'm_29', 'm_30', 'cmsg_new', 'm_31']);
    expect(oldestCanonical(list)?.id).toBe('m_28');
    expect(newestCanonical(list)?.id).toBe('m_31');
  });
});

describe('delivery and read receipts', () => {
  it('advances only the targeted canonical messages and never goes backwards', () => {
    const list = [
      canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'),
      { ...canonical('m_2', 'cmsg_2', '2026-01-01T10:00:01.000Z'), deliveryState: 'read' as const },
      optimistic('cmsg_3', '2026-01-01T10:00:02.000Z'),
    ];
    const next = applyDeliveryState(list, ['m_1', 'm_2', 'cmsg_3'], 'delivered', '2026-01-01T10:00:03.000Z');
    expect(next.map((item) => item.deliveryState)).toEqual(['delivered', 'read', 'sending']);
    expect(next[0]!.deliveredAt).toBe('2026-01-01T10:00:03.000Z');
    // A second identical receipt is a no-op.
    expect(applyDeliveryState(next, ['m_1'], 'delivered')).toBe(next);
  });

  it('applies a read watermark only to the peer-facing messages at or before it', () => {
    const list = [
      canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z'),
      canonical('m_2', 'cmsg_2', '2026-01-01T10:00:05.000Z'),
      message({ id: 'm_3', senderId: PEER, createdAt: '2026-01-01T10:00:03.000Z', updatedAt: '2026-01-01T10:00:03.000Z' }),
    ];
    const next = applyReadWatermark(list, ME, '2026-01-01T10:00:03.000Z');
    const byId = Object.fromEntries(next.map((item) => [item.id, item.deliveryState]));
    expect(byId).toEqual({ m_1: 'read', m_2: 'sent', m_3: 'sent' });
  });

  it('lists the peer messages that still need a delivered acknowledgement', () => {
    const list = [
      canonical('m_mine', 'cmsg_1', '2026-01-01T10:00:00.000Z'),
      message({ id: 'm_new', senderId: PEER, createdAt: '2026-01-01T10:00:01.000Z' }),
      message({ id: 'm_done', senderId: PEER, deliveryState: 'delivered', createdAt: '2026-01-01T10:00:02.000Z' }),
    ];
    expect(pendingDeliveryIds(list, ME)).toEqual(['m_new']);
  });
});

describe('ordering', () => {
  it('is deterministic for equal timestamps', () => {
    const a = message({ id: 'm_b', createdAt: '2026-01-01T10:00:00.000Z' });
    const b = message({ id: 'm_a', createdAt: '2026-01-01T10:00:00.000Z' });
    expect(ids(sortMessages([a, b]))).toEqual(['m_a', 'm_b']);
    expect(ids(sortMessages([b, a]))).toEqual(['m_a', 'm_b']);
  });

  it('reconcileMessage returns the same object when nothing changed', () => {
    const a = canonical('m_1', 'cmsg_1', '2026-01-01T10:00:00.000Z');
    expect(reconcileMessage(a, { ...a })).toBe(a);
  });
});

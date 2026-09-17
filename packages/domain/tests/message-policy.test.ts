import { describe, expect, it } from 'vitest';
import { MESSAGE_EDIT_WINDOW_MS, type Message } from '@mt/types';
import {
  canDeleteMessage,
  canEditMessage,
  canMarkDelivered,
  isWithinEditWindow,
  nextDeliveryState,
  softDeleteMessage,
  toMessageForUser,
} from '../src/message-policy';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const createdAt = new Date(NOW - 30_000).toISOString();

const baseMessage = {
  id: 'm1',
  conversationId: 'c1',
  senderId: 'alice',
  createdAt,
  deleted: false,
} as unknown as Message;

describe('isWithinEditWindow', () => {
  it('allows edits inside the two minute window', () => {
    expect(isWithinEditWindow(createdAt, NOW)).toBe(true);
    expect(isWithinEditWindow(new Date(NOW - MESSAGE_EDIT_WINDOW_MS).toISOString(), NOW)).toBe(true);
  });

  it('rejects edits after the window', () => {
    expect(isWithinEditWindow(new Date(NOW - MESSAGE_EDIT_WINDOW_MS - 1).toISOString(), NOW)).toBe(false);
  });

  it('accepts a numeric timestamp and rejects a malformed one', () => {
    expect(isWithinEditWindow(NOW - 1000, NOW)).toBe(true);
    expect(isWithinEditWindow('not a date', NOW)).toBe(false);
  });
});

describe('canEditMessage', () => {
  it('allows the author inside the window', () => {
    expect(canEditMessage({ message: baseMessage, actorId: 'alice', nowMs: NOW })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('refuses another participant', () => {
    const check = canEditMessage({ message: baseMessage, actorId: 'bob', nowMs: NOW });
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/author/);
  });

  it('refuses after the window even for the author', () => {
    const late = canEditMessage({ message: baseMessage, actorId: 'alice', nowMs: NOW + 5 * 60_000 });
    expect(late.allowed).toBe(false);
    expect(late.reason).toMatch(/2 minutes/);
  });

  it('refuses a deleted message', () => {
    const check = canEditMessage({
      message: { ...baseMessage, deleted: true },
      actorId: 'alice',
      nowMs: NOW,
    });
    expect(check.allowed).toBe(false);
  });
});

describe('canDeleteMessage', () => {
  it('refuses to delete the same message twice', () => {
    expect(canDeleteMessage({ message: { ...baseMessage, deleted: true }, actorId: 'alice' }).allowed).toBe(false);
  });

  it('lets only the author delete for everyone (a recipient hides it for themselves instead)', () => {
    expect(canDeleteMessage({ message: baseMessage, actorId: 'alice' }).allowed).toBe(true);
    expect(canDeleteMessage({ message: baseMessage, actorId: 'bob' }).allowed).toBe(false);
  });
});

describe('softDeleteMessage', () => {
  it('preserves edit history and records who deleted it, when and why', () => {
    const message = {
      ...baseMessage,
      text: 'secret',
      editHistory: [{ text: 'original', editedAt: createdAt, editedBy: 'alice' }],
    } as unknown as Message;
    const { patch, reason } = softDeleteMessage({
      message,
      actorId: 'alice',
      reason: 'mistake',
      now: '2026-01-01T12:05:00.000Z',
    });
    expect(patch.deleted).toBe(true);
    expect(patch.deletedBy).toBe('alice');
    expect(patch.deletedAt).toBe('2026-01-01T12:05:00.000Z');
    expect(patch.text).toBeNull();
    expect(patch.editHistory).toHaveLength(1);
    expect(reason).toBe('mistake');
  });
});

describe('toMessageForUser', () => {
  it('hides deleted content from participants', () => {
    const deleted = { ...baseMessage, deleted: true, text: 'secret', metadata: {} } as unknown as Message;
    expect(toMessageForUser(deleted, 'bob').text).toBeNull();
  });

  it('never leaks edit history or internal metadata', () => {
    const view = toMessageForUser({ ...baseMessage, text: 'hi', editHistory: [{ text: 'x' }], metadata: { a: 1 } } as unknown as Message, 'bob');
    expect(view.text).toBe('hi');
    expect('editHistory' in view).toBe(false);
    expect('metadata' in view).toBe(false);
  });
});

describe('delivery state machine', () => {
  it('only moves forward', () => {
    expect(nextDeliveryState('sent', 'delivered')).toBe('delivered');
    expect(nextDeliveryState('read', 'sent')).toBe('read');
    expect(nextDeliveryState('delivered', 'sending')).toBe('delivered');
  });

  it('lets a retry restart a failed message', () => {
    expect(nextDeliveryState('failed', 'sending')).toBe('sending');
  });

  it('only the recipient advances delivery', () => {
    expect(canMarkDelivered({ senderId: 'alice', deliveryState: 'sent' }, 'bob')).toBe(true);
    expect(canMarkDelivered({ senderId: 'alice', deliveryState: 'sent' }, 'alice')).toBe(false);
  });
});

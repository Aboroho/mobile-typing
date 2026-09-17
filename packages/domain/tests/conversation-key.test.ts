import { expect, it } from 'vitest';
import type { Conversation } from '@mt/types';
import { conversationKeyFor, isParticipant, otherParticipant, participantIdsFromKey } from '../src/conversation-key';

it('produces the same key regardless of argument order, so a pair is one conversation', () => {
  expect(conversationKeyFor('alice', 'bob')).toBe(conversationKeyFor('bob', 'alice'));
  expect(conversationKeyFor('alice', 'bob')).toBe('alice__bob');
});

it('round-trips through participantIdsFromKey', () => {
  expect(participantIdsFromKey(conversationKeyFor('bob', 'alice'))).toEqual(['alice', 'bob']);
  expect(() => participantIdsFromKey('malformed')).toThrow(RangeError);
});

it('refuses a conversation with a single participant', () => {
  expect(() => conversationKeyFor('alice', 'alice')).toThrow(RangeError);
});

it('answers participant questions', () => {
  const conversation = { participantIds: ['alice', 'bob'] } as unknown as Conversation;
  expect(isParticipant(conversation, 'alice')).toBe(true);
  expect(isParticipant(conversation, 'carol')).toBe(false);
  expect(otherParticipant(conversation, 'alice')).toBe('bob');
  expect(() => otherParticipant(conversation, 'carol')).toThrow(RangeError);
});

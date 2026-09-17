import type { Conversation, ConversationParticipantState, ConversationView } from '@mt/types';
import { nowIso } from '@mt/utils';

/**
 * Deterministic key for a 1:1 pair: the two user ids joined in lexicographic
 * order. The same conversation is found regardless of who starts it, which is
 * what makes duplicate conversations impossible.
 */
export function conversationKeyFor(a: string, b: string): string {
  if (a === b) throw new RangeError('a conversation needs two different participants');
  return [a, b].sort().join('__');
}

export function participantIdsFromKey(key: string): [string, string] {
  const [a, b] = key.split('__');
  if (!a || !b) throw new RangeError('malformed participant key');
  return [a, b];
}

export function otherParticipant(conversation: Conversation, viewerId: string): string {
  const [a, b] = conversation.participantIds;
  if (viewerId === a) return b;
  if (viewerId === b) return a;
  throw new RangeError('viewer is not a participant of this conversation');
}

export function isParticipant(conversation: Conversation, userId: string): boolean {
  return conversation.participantIds.includes(userId);
}

export function emptyParticipantState(): ConversationParticipantState {
  return {
    lastReadAt: null,
    lastReadMessageAt: null,
    unreadCount: 0,
    hidden: false,
    hiddenAt: null,
    blockedUserIds: [],
  };
}

export function hasBlocked(conversation: Conversation, viewerId: string, otherId: string): boolean {
  const state = conversation.participants[viewerId];
  return Boolean(state?.blockedUserIds.includes(otherId));
}

/** Recomputes unread count from the participant's read watermark. */
export function unreadCountFor(
  conversation: Conversation,
  viewerId: string,
  lastMessageAt: string | null,
): number {
  const state = conversation.participants[viewerId];
  if (!state || !lastMessageAt) return 0;
  if (!state.lastReadMessageAt) return state.unreadCount;
  return new Date(lastMessageAt).getTime() > new Date(state.lastReadMessageAt).getTime()
    ? Math.max(1, state.unreadCount)
    : 0;
}

export function toConversationView(
  conversation: Conversation,
  viewerId: string,
  other: ConversationView['otherUser'],
  isTyping = false,
): ConversationView {
  const state = conversation.participants[viewerId] ?? emptyParticipantState();
  return {
    conversation,
    otherUser: other,
    unreadCount: state.unreadCount,
    hidden: state.hidden,
    isTyping,
  };
}

export function touchConversation(conversation: Conversation, at: string = nowIso()): Conversation {
  return { ...conversation, updatedAt: at, lastActivityAt: at };
}

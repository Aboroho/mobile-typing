import type { EntityTimestamps, Timestamp } from './common';
import type { MessagePreview } from './message';
import type { PublicUserSummary } from './user';

/** Deterministic id for a 1:1 pair, independent of who created it. */
export type ParticipantKey = string;

export interface Conversation extends EntityTimestamps {
  id: string;
  /** Exactly two user ids, always sorted lexicographically. */
  participantIds: [string, string];
  participantKey: ParticipantKey;
  lastMessage: MessagePreview | null;
  lastActivityAt: Timestamp;
  lastMessageAt: Timestamp | null;
  /** Per participant bookkeeping keyed by user id. */
  participants: Record<string, ConversationParticipantState>;
}

export interface ConversationParticipantState {
  lastReadAt: Timestamp | null;
  lastReadMessageAt: Timestamp | null;
  unreadCount: number;
  /** Soft "remove from my list"; the conversation reappears on the next message. */
  hidden: boolean;
  hiddenAt: Timestamp | null;
  /** Users this participant blocked inside the conversation. */
  blockedUserIds: string[];
}

/** Conversation plus the fields the list view needs for the *viewer*. */
export interface ConversationView {
  conversation: Conversation;
  otherUser: PublicUserSummary;
  unreadCount: number;
  hidden: boolean;
  isTyping: boolean;
}

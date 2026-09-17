import { AppError, conversationKeyFor, emptyParticipantState, otherParticipant, toConversationView } from '@mt/domain';
import type { Conversation, ConversationView, Cursor, PublicUserSummary } from '@mt/types';
import { newId, nowIso } from '@mt/utils';
import { getData, type UserRecord } from '../data';
import { publish, topics } from '../realtime/bus';
import { toPublicSummary } from './user-service';

async function loadSummaries(userIds: string[]): Promise<Map<string, PublicUserSummary>> {
  const data = await getData();
  const map = new Map<string, PublicUserSummary>();
  await Promise.all(
    userIds.map(async (id) => {
      if (map.has(id)) return;
      const record = await data.users.getById(id);
      if (record) map.set(id, toPublicSummary(record));
      else map.set(id, { id, name: 'Unknown user', photoUrl: null, presence: 'offline' });
    }),
  );
  return map;
}

/**
 * Creates or returns the single 1:1 conversation between two users. The
 * participant key makes the operation idempotent: two people who both hit
 * "new conversation" end up in the same thread.
 */
export async function ensureConversation(input: {
  actorId: string;
  otherId: string;
}): Promise<Conversation> {
  if (input.actorId === input.otherId) {
    throw new AppError('BAD_REQUEST', 'you cannot start a conversation with yourself');
  }
  const data = await getData();
  const other: UserRecord | null = await data.users.getById(input.otherId);
  if (!other) throw AppError.notFound('that person is not available');
  if (other.status !== 'active') throw AppError.forbidden('that person is not available');

  const key = conversationKeyFor(input.actorId, input.otherId);
  const existing = await data.conversations.findByParticipantKey(key);
  if (existing) return existing;

  const now = nowIso();
  const conversation: Conversation = {
    id: newId('c'),
    participantIds: [input.actorId, input.otherId].sort() as [string, string],
    participantKey: key,
    lastMessage: null,
    lastActivityAt: now,
    lastMessageAt: null,
    createdAt: now,
    updatedAt: now,
    participants: {
      [input.actorId]: emptyParticipantState(),
      [input.otherId]: emptyParticipantState(),
    },
  };
  return data.conversations.create(conversation);
}

export async function requireParticipant(conversationId: string, userId: string): Promise<Conversation> {
  const data = await getData();
  const conversation = await data.conversations.getById(conversationId);
  if (!conversation) throw AppError.notFound('conversation not found');
  if (!conversation.participantIds.includes(userId)) {
    // Same message as "not found" so the id space cannot be probed.
    throw AppError.notFound('conversation not found');
  }
  return conversation;
}

export async function listConversations(input: {
  userId: string;
  limit: number;
  cursor?: string | null;
  includeHidden?: boolean;
}): Promise<Cursor<ConversationView>> {
  const data = await getData();
  const page = await data.conversations.list({
    userId: input.userId,
    limit: input.limit,
    cursor: input.cursor,
    includeHidden: input.includeHidden,
  });
  const otherIds = page.items.map((conversation) => otherParticipant(conversation, input.userId));
  const summaries = await loadSummaries(otherIds);
  return {
    ...page,
    items: page.items.map((conversation) => {
      const otherId = otherParticipant(conversation, input.userId);
      return toConversationView(
        conversation,
        input.userId,
        summaries.get(otherId) ?? { id: otherId, name: 'Unknown user', photoUrl: null, presence: 'offline' },
      );
    }),
  };
}

export async function getConversationView(
  conversation: Conversation,
  viewerId: string,
): Promise<ConversationView> {
  const otherId = otherParticipant(conversation, viewerId);
  const summaries = await loadSummaries([otherId]);
  return toConversationView(
    conversation,
    viewerId,
    summaries.get(otherId) ?? { id: otherId, name: 'Unknown user', photoUrl: null, presence: 'offline' },
  );
}

export async function markConversationRead(input: {
  userId: string;
  conversationId: string;
  lastReadMessageAt: string;
}): Promise<void> {
  const data = await getData();
  const conversation = await requireParticipant(input.conversationId, input.userId);
  await data.conversations.updateParticipant(input.conversationId, input.userId, {
    lastReadAt: nowIso(),
    lastReadMessageAt: input.lastReadMessageAt,
    unreadCount: 0,
    hidden: false,
    hiddenAt: null,
  });
  publish(topics.conversation(input.conversationId), 'conversation.read', {
    conversationId: input.conversationId,
    userId: input.userId,
    lastReadMessageAt: input.lastReadMessageAt,
    otherUserId: otherParticipant(conversation, input.userId),
  });
}

export async function setConversationHidden(input: {
  userId: string;
  conversationId: string;
  hidden: boolean;
}): Promise<void> {
  const data = await getData();
  await requireParticipant(input.conversationId, input.userId);
  await data.conversations.updateParticipant(input.conversationId, input.userId, {
    hidden: input.hidden,
    hiddenAt: input.hidden ? nowIso() : null,
  });
}

/**
 * Blocking is per conversation and only suppresses delivery in this thread; it is
 * not a global mute. Documented in docs/decisions.md.
 */
export async function setBlocked(input: {
  userId: string;
  conversationId: string;
  blockedUserId: string;
  blocked: boolean;
}): Promise<void> {
  const data = await getData();
  const conversation = await requireParticipant(input.conversationId, input.userId);
  const current = conversation.participants[input.userId] ?? emptyParticipantState();
  const blocked = new Set(current.blockedUserIds);
  if (input.blocked) blocked.add(input.blockedUserId);
  else blocked.delete(input.blockedUserId);
  await data.conversations.updateParticipant(input.conversationId, input.userId, {
    blockedUserIds: Array.from(blocked),
  });
}

export async function setTyping(input: {
  userId: string;
  conversationId: string;
  isTyping: boolean;
}): Promise<void> {
  const conversation = await requireParticipant(input.conversationId, input.userId);
  publish(topics.typing(input.conversationId), 'typing', {
    conversationId: input.conversationId,
    userId: input.userId,
    isTyping: input.isTyping,
    otherUserId: otherParticipant(conversation, input.userId),
  });
}

import { AppError, conversationKeyFor, messagePreviewFor } from '@mt/domain';
import type {
  AuditLogEntry,
  CallView,
  Cursor,
  Dashboard,
  MediaForAdmin,
  MessageForAdmin,
  RecentActivity,
  SecretCodeStatus,
} from '@mt/types';
import { formatDuration } from '@mt/utils';
import type { AdminUserRow } from '@mt/types';
import { getData, type UserRecord } from '../data';
import { isAdminUser } from '../auth/session';
import { revokeAllSessionsForUser } from '../auth/session';
import { writeAuditLog } from '../security/audit';
import { ensureAccessConfig } from '../access/access-service';
import { toCallView } from './call-service';
import { logger } from '../logger';

export interface AdminActor {
  id: string;
  email: string;
  ipAddress: string | null;
}

export async function getDashboard(): Promise<Dashboard> {
  const data = await getData();
  const [users, conversationCount, messageCounts, mediaCounts, callCount, typingCount] = await Promise.all([
    data.users.countByStatus(),
    data.conversations.countAll(),
    data.messages.countAll(),
    data.media.countAll(),
    data.calls.countAll(),
    data.typingSessions.countAll(),
  ]);
  const recentMessages = await data.messages.listRecent(10);
  const recentCalls = await data.calls.list({ limit: 5 });
  const recentAudit = await data.audit.list({ limit: 5 });

  const recent: RecentActivity[] = [
    ...recentMessages.map((message) => ({
      id: message.id,
      kind: 'message' as const,
      title: message.deleted ? 'Deleted message' : messagePreviewFor(message, message.senderId).text,
      description: `${message.type} · ${message.senderId.slice(0, 12)}`,
      createdAt: message.createdAt,
    })),
    ...recentCalls.items.map((call) => ({
      id: call.id,
      kind: 'call' as const,
      title: `Audio call ${call.status}`,
      description: call.durationMs ? formatDuration(call.durationMs) : 'no answer',
      createdAt: call.createdAt,
    })),
    ...recentAudit.items.map((entry) => ({
      id: entry.id,
      kind: 'audit' as const,
      title: entry.action,
      description: entry.actorEmail ?? entry.actorUid,
      createdAt: entry.createdAt,
    })),
  ]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 12);

  return {
    stats: {
      totalUsers: users.total,
      activeUsers: users.active,
      disabledUsers: users.disabled,
      conversations: conversationCount,
      messages: messageCounts.total,
      deletedMessages: messageCounts.deleted,
      media: mediaCounts.total,
      viewOnceMedia: mediaCounts.viewOnce,
      deletedMedia: mediaCounts.deleted,
      calls: callCount,
      typingSessions: typingCount,
      last24hMessages: messageCounts.last24h,
    },
    recent,
    generatedAt: new Date().toISOString(),
  };
}

export async function secretCodeStatus(): Promise<SecretCodeStatus> {
  const config = await ensureAccessConfig();
  return {
    // The code itself is never returned — only its presence and length.
    configured: Boolean(config.code),
    length: config.code ? config.code.length : null,
    epoch: config.epoch,
    caseSensitive: config.caseSensitive,
    maxLength: config.maxLength,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
    unlockCount: config.unlockCount,
  };
}

export async function listUsers(params: {
  q?: string;
  status?: 'active' | 'disabled' | 'deleted';
  limit: number;
  cursor?: string | null;
}): Promise<Cursor<AdminUserRow>> {
  const data = await getData();
  return data.users.list(params);
}

export async function getUserDetail(userId: string) {
  const data = await getData();
  const record = await data.users.getById(userId);
  if (!record) throw AppError.notFound('user not found');
  const conversations = await data.conversations.list({ userId, limit: 100 });
  const messages = await data.messages.listForUser(userId, 1);
  return {
    user: stripSecrets(record),
    conversationCount: conversations.items.length,
    messageCount: messages.items.length,
  };
}

/**
 * A profile as the admin panel sees it. No credential material is stored any
 * more — Firebase Authentication owns passwords — so all that is left to do is
 * re-derive `isAdmin` from the server environment instead of trusting a stored
 * flag.
 */
function stripSecrets(record: UserRecord) {
  return { ...record, isAdmin: isAdminUser(record) };
}

export async function updateUserStatus(input: {
  admin: AdminActor;
  userId: string;
  status: 'active' | 'disabled';
  reason?: string;
}): Promise<ReturnType<typeof stripSecrets>> {
  const data = await getData();
  const record = await data.users.getById(input.userId);
  if (!record) throw AppError.notFound('user not found');
  if (isAdminUser(record)) {
    throw new AppError('FORBIDDEN', 'the administrator account cannot be disabled');
  }
  // When disabling an account, revoke all active sessions so the user is
  // immediately logged out on every device.
  if (input.status === 'disabled') {
    await revokeAllSessionsForUser(input.userId).catch(() => null);
  }
  const updated = await data.users.update(input.userId, {
    status: input.status,
    disabledReason: input.status === 'disabled' ? (input.reason ?? null) : null,
  });
  await writeAuditLog({
    actor: { id: input.admin.id, email: input.admin.email },
    action: 'admin.user.status_changed',
    targetType: 'user',
    targetId: input.userId,
    ipAddress: input.admin.ipAddress,
    metadata: { status: input.status, reason: input.reason ?? null },
  });
  logger.warn('admin.user_status_changed', { userId: input.userId, status: input.status });
  if (!updated) throw AppError.notFound('user not found');
  return stripSecrets(updated);
}

/**
 * Locates (but never creates) the 1:1 conversation between two users and logs
 * the inspection. Every read of a conversation an administrator is not part of
 * is audited.
 */
export async function inspectConversation(input: {
  admin: AdminActor;
  participantA: string;
  participantB: string;
}) {
  const data = await getData();
  if (input.participantA === input.participantB) {
    throw new AppError('BAD_REQUEST', 'choose two different users');
  }
  const key = conversationKeyFor(input.participantA, input.participantB);
  const conversation = await data.conversations.findByParticipantKey(key);
  const [a, b] = await Promise.all([
    data.users.getById(input.participantA),
    data.users.getById(input.participantB),
  ]);
  if (!a || !b) throw AppError.notFound('one of the selected users does not exist');

  await writeAuditLog({
    actor: { id: input.admin.id, email: input.admin.email },
    action: 'admin.conversation.inspected',
    targetType: 'conversation',
    targetId: conversation?.id ?? null,
    ipAddress: input.admin.ipAddress,
    metadata: { participantA: input.participantA, participantB: input.participantB, exists: Boolean(conversation) },
  });

  return {
    conversationId: conversation?.id ?? null,
    exists: Boolean(conversation),
    participants: [a, b].map((user) => ({
      id: user.id,
      name: user.name,
      photoUrl: user.photoUrl,
      presence: 'offline' as const,
    })),
    messageCount: conversation ? await data.messages.countForConversation(conversation.id) : 0,
  };
}

/**
 * Reads a conversation including soft deleted rows. Deleted content stays
 * available to administrators by design, so the access itself is logged.
 */
export async function listConversationMessages(input: {
  admin: AdminActor;
  conversationId: string;
  limit: number;
  cursor?: string | null;
  q?: string;
}): Promise<Cursor<MessageForAdmin>> {
  const data = await getData();
  const conversation = await data.conversations.getById(input.conversationId);
  if (!conversation) throw AppError.notFound('conversation not found');
  const page = await data.messages.list({
    conversationId: input.conversationId,
    limit: input.limit,
    cursor: input.cursor,
    includeDeleted: true,
  });
  const query = input.q?.trim().toLowerCase();
  const items = (query
    ? page.items.filter((message) => (message.text ?? '').toLowerCase().includes(query))
    : page.items
  ).map((message) => ({ ...message, sender: null }));

  const senders = await Promise.all(
    conversation.participantIds.map((id) => data.users.getById(id)),
  );
  const senderMap = new Map(senders.filter(Boolean).map((user) => [user!.id, user!]));
  const enriched = items.map((message) => {
    const sender = senderMap.get(message.senderId);
    return {
      ...message,
      sender: sender ? { id: sender.id, name: sender.name, email: sender.email } : null,
    };
  });

  await writeAuditLog({
    actor: { id: input.admin.id, email: input.admin.email },
    action: query ? 'admin.conversation.inspected' : 'admin.conversation.inspected',
    targetType: 'conversation',
    targetId: input.conversationId,
    ipAddress: input.admin.ipAddress,
    metadata: {
      count: enriched.length,
      search: query ? 'yes' : 'no',
      includesDeleted: page.items.some((message) => message.deleted),
    },
  });

  return { ...page, items: enriched };
}

export async function listMedia(params: {
  kind?: 'image' | 'voice';
  includeDeleted?: boolean;
  viewOnceOnly?: boolean;
  limit: number;
  cursor?: string | null;
}): Promise<Cursor<MediaForAdmin>> {
  const data = await getData();
  const page = await data.media.list(params);
  return {
    ...page,
    items: page.items.map((media) => ({
      ...media,
      messageSender: null,
      conversationParticipants: [],
    })),
  };
}

export async function listCalls(params: { limit: number; cursor?: string | null }): Promise<Cursor<CallView>> {
  const data = await getData();
  const page = await data.calls.list(params);
  return { ...page, items: page.items.map(toCallView) };
}

export async function listAuditLogs(params: {
  limit: number;
  cursor?: string | null;
  action?: string;
  actorUid?: string;
}): Promise<Cursor<AuditLogEntry>> {
  const data = await getData();
  return data.audit.list(params);
}

/** Convenience used by the media panel before streaming an object. */
export async function assertAdminMediaAccess(admin: AdminActor, mediaId: string): Promise<MediaForAdmin> {
  const data = await getData();
  const media = await data.media.getById(mediaId);
  if (!media) throw AppError.notFound('media not found');
  await writeAuditLog({
    actor: { id: admin.id, email: admin.email },
    action: 'admin.media.inspected',
    targetType: 'media',
    targetId: mediaId,
    ipAddress: admin.ipAddress,
    metadata: { deleted: media.deleted, viewOnce: media.viewOnce, state: media.viewOnceState },
  });
  return { ...media, messageSender: null, conversationParticipants: [] };
}

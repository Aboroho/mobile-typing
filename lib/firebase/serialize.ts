import type {
  Call,
  Conversation,
  Media,
  Message,
  UserProfile,
} from '@mt/types';
import type { AccessConfigRecord, AuditLogEntryAlias, UserRecord } from './shapes';

/**
 * Firestore serialisation.
 *
 * Timestamps are stored as ISO-8601 UTC strings rather than Firestore
 * `Timestamp` values. ISO-8601 sorts lexicographically in the same order it
 * sorts chronologically, so `orderBy` + `startAfter` cursors work with plain
 * strings and the same shape is used by the memory provider and the API layer
 * (see docs/decisions.md).
 */
export function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

export function toUserRecord(docId: string, data: Record<string, unknown>): UserRecord {
  return {
    id: docId,
    name: String(data['name'] ?? ''),
    email: String(data['email'] ?? ''),
    photoUrl: (data['photoUrl'] as string | null) ?? null,
    status: (data['status'] as UserProfile['status']) ?? 'active',
    lastLoginAt: (data['lastLoginAt'] as string | null) ?? null,
    isAdmin: Boolean(data['isAdmin']),
    createdAt: String(data['createdAt']),
    updatedAt: String(data['updatedAt']),
    disabledReason: (data['disabledReason'] as string | null) ?? null,
  };
}

export function toUserProfile(record: UserRecord): UserProfile {
  const { disabledReason: _reason, ...profile } = record;
  void _reason;
  return profile;
}

export function toConversation(docId: string, data: Record<string, unknown>): Conversation {
  const participants = (data['participants'] ?? {}) as Conversation['participants'];
  return {
    id: docId,
    participantIds: data['participantIds'] as [string, string],
    participantKey: String(data['participantKey']),
    lastMessage: (data['lastMessage'] as Conversation['lastMessage']) ?? null,
    lastActivityAt: String(data['lastActivityAt']),
    lastMessageAt: (data['lastMessageAt'] as string | null) ?? null,
    createdAt: String(data['createdAt']),
    updatedAt: String(data['updatedAt']),
    participants: normalizeParticipants(participants),
  };
}

function normalizeParticipants(
  input: Record<string, Partial<Conversation['participants'][string]>>,
): Conversation['participants'] {
  const out: Conversation['participants'] = {};
  for (const [userId, state] of Object.entries(input)) {
    out[userId] = {
      lastReadAt: state.lastReadAt ?? null,
      lastReadMessageAt: state.lastReadMessageAt ?? null,
      unreadCount: state.unreadCount ?? 0,
      hidden: state.hidden ?? false,
      hiddenAt: state.hiddenAt ?? null,
      blockedUserIds: state.blockedUserIds ?? [],
    };
  }
  return out;
}

export function toMessage(docId: string, data: Record<string, unknown>): Message {
  return {
    id: docId,
    conversationId: String(data['conversationId']),
    senderId: String(data['senderId']),
    type: data['type'] as Message['type'],
    text: (data['text'] as string | null) ?? null,
    media: (data['media'] as Message['media']) ?? null,
    call: (data['call'] as Message['call']) ?? null,
    replyTo: (data['replyTo'] as Message['replyTo']) ?? null,
    deliveryState: (data['deliveryState'] as Message['deliveryState']) ?? 'sent',
    deliveredAt: (data['deliveredAt'] as string | null) ?? null,
    readBy: (data['readBy'] as string[]) ?? [],
    readAt: (data['readAt'] as string | null) ?? null,
    edited: Boolean(data['edited']),
    editedAt: (data['editedAt'] as string | null) ?? null,
    editHistory: (data['editHistory'] as Message['editHistory']) ?? [],
    deleted: Boolean(data['deleted']),
    deletedAt: (data['deletedAt'] as string | null) ?? null,
    deletedBy: (data['deletedBy'] as string | null) ?? null,
    clientMessageId: (data['clientMessageId'] as string | null) ?? null,
    hiddenForUserIds: (data['hiddenForUserIds'] as string[]) ?? [],
    metadata: (data['metadata'] as Message['metadata']) ?? {},
    createdAt: String(data['createdAt']),
    updatedAt: String(data['updatedAt']),
  };
}

export function toMedia(docId: string, data: Record<string, unknown>): Media {
  return {
    id: docId,
    ownerId: String(data['ownerId']),
    conversationId: (data['conversationId'] as string | null) ?? null,
    messageId: (data['messageId'] as string | null) ?? null,
    kind: data['kind'] as Media['kind'],
    storagePath: String(data['storagePath']),
    mimeType: String(data['mimeType']),
    sizeBytes: Number(data['sizeBytes'] ?? 0),
    width: (data['width'] as number | null) ?? null,
    height: (data['height'] as number | null) ?? null,
    durationMs: (data['durationMs'] as number | null) ?? null,
    checksum: String(data['checksum'] ?? ''),
    viewOnce: Boolean(data['viewOnce']),
    viewOnceState: (data['viewOnceState'] as Media['viewOnceState']) ?? null,
    viewedAt: (data['viewedAt'] as string | null) ?? null,
    viewedBy: (data['viewedBy'] as string | null) ?? null,
    deleted: Boolean(data['deleted']),
    deletedAt: (data['deletedAt'] as string | null) ?? null,
    deletedBy: (data['deletedBy'] as string | null) ?? null,
    createdAt: String(data['createdAt']),
    updatedAt: String(data['updatedAt']),
  };
}

export function toCall(docId: string, data: Record<string, unknown>): Call {
  return {
    id: docId,
    conversationId: String(data['conversationId']),
    initiatorId: String(data['initiatorId']),
    recipientId: String(data['recipientId']),
    type: (data['type'] as Call['type']) ?? 'audio',
    status: data['status'] as Call['status'],
    startedAt: (data['startedAt'] as string | null) ?? null,
    answeredAt: (data['answeredAt'] as string | null) ?? null,
    endedAt: (data['endedAt'] as string | null) ?? null,
    durationMs: (data['durationMs'] as number | null) ?? null,
    endReason: (data['endReason'] as Call['endReason']) ?? null,
    diagnostics: (data['diagnostics'] as Call['diagnostics']) ?? {
      iceState: null,
      connectionState: null,
      turnUsed: null,
    },
    createdAt: String(data['createdAt']),
    updatedAt: String(data['updatedAt']),
  };
}

export function toAuditEntry(docId: string, data: Record<string, unknown>): AuditLogEntryAlias {
  return {
    id: docId,
    actorUid: String(data['actorUid']),
    actorEmail: (data['actorEmail'] as string | null) ?? null,
    action: String(data['action']),
    targetType: String(data['targetType']),
    targetId: (data['targetId'] as string | null) ?? null,
    metadata: (data['metadata'] as AuditLogEntryAlias['metadata']) ?? {},
    ipAddress: (data['ipAddress'] as string | null) ?? null,
    createdAt: String(data['createdAt']),
    updatedAt: String(data['updatedAt']),
  };
}

export function toAccessConfig(data: Record<string, unknown>): AccessConfigRecord {
  return {
    code: String(data['code'] ?? ''),
    digest: String(data['digest'] ?? ''),
    salt: String(data['salt'] ?? ''),
    maxLength: Number(data['maxLength'] ?? 15),
    caseSensitive: data['caseSensitive'] === undefined ? true : Boolean(data['caseSensitive']),
    epoch: Number(data['epoch'] ?? 1),
    unlockCount: Number(data['unlockCount'] ?? 0),
    updatedAt: (data['updatedAt'] as string | null) ?? null,
    updatedBy: (data['updatedBy'] as string | null) ?? null,
    createdAt: String(data['createdAt'] ?? new Date().toISOString()),
  };
}

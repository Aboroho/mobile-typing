/**
 * Prisma/PostgreSQL DataProvider implementation.
 *
 * This module is loaded lazily (see lib/data/index.ts) so that DATA_PROVIDER=memory
 * works without a live database. When DATA_PROVIDER=prisma is configured, the
 * PrismaClient is imported from @prisma/client — types are erased at runtime and
 * this file treats the client as `any` internally so type-checking still passes
 * before `prisma generate` has been run.
 */
import type {
  AdminUserRow,
  AuditLogEntry,
  Call,
  CallStatus,
  Conversation,
  ConversationParticipantState,
  Cursor,
  Media,
  MediaKind,
  Message,
  MessageType,
  PublicUserSummary,
  Timestamp,
  TypingSession,
  ViewOnceState,
} from '@mt/types';
import { ViewOnceState as VO } from '@mt/types';
import { newId } from '@mt/utils';
import type {
  AccessConfigRecord,
  AuditRepo,
  CallRepo,
  ConfigRepo,
  ConversationRepo,
  DataProvider,
  ListAuditParams,
  ListCallsParams,
  ListConversationsParams,
  ListMediaParams,
  ListMessagesParams,
  ListUsersParams,
  MediaRepo,
  MessageRepo,
  OutboxEventRecord,
  OutboxRepo,
  RateLimitRepo,
  SessionRecord,
  SessionRepo,
  SessionUserJoin,
  TypingSessionRepo,
  UserRecord,
  UserRepo,
  ViewOnceClaim,
} from '../types';
import { decodeCursor, encodeCursor } from '../memory/store';

function iso(date: Date | null | undefined): Timestamp | null {
  if (!date) return null;
  return date.toISOString();
}

function requiredIso(date: Date): Timestamp {
  return date.toISOString();
}

function nowIso(): Timestamp {
  return new Date().toISOString();
}

function toDateOrNull(ts: Timestamp | null | undefined): Date | null {
  if (!ts) return null;
  return new Date(ts);
}

// Lazy load prisma client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _prisma: any = null;
async function db(): Promise<any> {
  if (_prisma) return _prisma;
  const { getPrisma } = await import('../../prisma');
  _prisma = await getPrisma();
  return _prisma;
}

// ---------------------------------------------------------------------------
// Rate limits (in-memory, suitable for single-server deployments).
// ---------------------------------------------------------------------------
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

class PrismaSessions implements SessionRepo {
  async create(input: {
    id: string; userId: string; tokenHash: string; userAgent: string | null; ip: string | null;
    createdAt: Date; lastActiveAt: Date; expiresAt: Date;
  }): Promise<SessionRecord> {
    const p = await db();
    const created = await p.userSession.create({
      data: {
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        userAgent: input.userAgent,
        ip: input.ip,
        createdAt: input.createdAt,
        lastActiveAt: input.lastActiveAt,
        expiresAt: input.expiresAt,
      },
    });
    return {
      id: created.id,
      userId: created.userId,
      tokenHash: created.tokenHash,
      userAgent: created.userAgent,
      ip: created.ip,
      createdAt: created.createdAt,
      lastActiveAt: created.lastActiveAt,
      expiresAt: created.expiresAt,
      revokedAt: created.revokedAt,
    };
  }
  async findByTokenHash(tokenHash: string): Promise<(SessionRecord & { user: SessionUserJoin }) | null> {
    const p = await db();
    const row = await p.userSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      userAgent: row.userAgent,
      ip: row.ip,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      user: { id: row.user.id, email: row.user.email, name: row.user.name, disabled: row.user.status === 'disabled' },
    };
  }
  async touch(id: string, lastActiveAt: Date): Promise<void> {
    const p = await db();
    await p.userSession.update({ where: { id }, data: { lastActiveAt } }).catch(() => null);
  }
  async revokeByTokenHash(tokenHash: string): Promise<void> {
    const p = await db();
    await p.userSession.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  async revokeAllForUser(userId: string): Promise<number> {
    const p = await db();
    const result = await p.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return result.count;
  }
}

class PrismaRateLimits implements RateLimitRepo {
  async consume(key: string, options: { limit: number; windowMs: number }) {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return { allowed: true, remaining: options.limit - 1, resetAt: now + options.windowMs, retryAfterSeconds: 0 };
    }
    bucket.count += 1;
    const allowed = bucket.count <= options.limit;
    const retryAfterSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed, remaining: Math.max(0, options.limit - bucket.count), resetAt: bucket.resetAt, retryAfterSeconds };
  }
}

// ---------------------------------------------------------------------------
// User Repo
// ---------------------------------------------------------------------------

function isAdminUserId(userId: string, email: string): boolean {
  const adminUid = process.env.ADMIN_UID ?? '';
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (adminUid && userId === adminUid) return true;
  if (adminEmail && email.trim().toLowerCase() === adminEmail) return true;
  return false;
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    photoUrl: (row.photoUrl as string | null) ?? null,
    status: row.status as UserRecord['status'],
    lastLoginAt: iso(row.lastLoginAt as Date | null),
    isAdmin: isAdminUserId(row.id as string, row.email as string),
    createdAt: requiredIso(row.createdAt as Date),
    updatedAt: requiredIso(row.updatedAt as Date),
    disabledReason: (row.disabledReason as string | null) ?? null,
  };
}

class PrismaUsers implements UserRepo {
  async create(record: UserRecord): Promise<UserRecord> {
    const p = await db();
    const extras = (record as unknown as { passwordHash?: string | null });
    const created = await p.user.create({
      data: {
        id: record.id,
        name: record.name,
        email: record.email,
        emailNormalized: record.email.toLowerCase(),
        passwordHash: extras.passwordHash ?? '',
        photoUrl: record.photoUrl,
        status: record.status,
        disabledReason: record.disabledReason,
        lastLoginAt: record.lastLoginAt ? new Date(record.lastLoginAt) : null,
      },
    });
    return mapUser(created);
  }

  async getById(userId: string): Promise<UserRecord | null> {
    const p = await db();
    const row = await p.user.findUnique({ where: { id: userId } });
    return row ? mapUser(row) : null;
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const p = await db();
    const row = await p.user.findUnique({ where: { emailNormalized: email.trim().toLowerCase() } });
    return row ? mapUser(row) : null;
  }

  async update(userId: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const p = await db();
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.email !== undefined) {
      data.email = patch.email;
      data.emailNormalized = patch.email.toLowerCase();
    }
    if (patch.photoUrl !== undefined) data.photoUrl = patch.photoUrl;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.disabledReason !== undefined) data.disabledReason = patch.disabledReason;
    if (patch.lastLoginAt !== undefined) data.lastLoginAt = toDateOrNull(patch.lastLoginAt);
    const row = await p.user.update({ where: { id: userId }, data });
    return mapUser(row);
  }

  async list(params: ListUsersParams): Promise<Cursor<AdminUserRow>> {
    const p = await db();
    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    if (params.q) {
      const q = params.q.trim().toLowerCase();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { emailNormalized: { contains: q, mode: 'insensitive' } },
      ];
    }
    const msgGroups = (await p.message.groupBy({ by: ['senderId'], _count: { id: true } })) as Array<{ senderId: string; _count: { id: number } }>;
    const convGroups = (await p.conversationMember.groupBy({ by: ['userId'], _count: { id: true } })) as Array<{ userId: string; _count: { id: number } }>;
    const msgCounts = new Map<string, number>();
    for (const g of msgGroups) msgCounts.set(g.senderId, g._count.id);
    const convCounts = new Map<string, number>();
    for (const g of convGroups) convCounts.set(g.userId, g._count.id);
    const queryExtra: Record<string, unknown> = {
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: params.limit + 1,
    };
    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      if (c) {
        Object.assign(queryExtra, { cursor: { createdAt: new Date(c.createdAtMs), id: c.id }, skip: 1 });
      }
    }
    const users = await p.user.findMany(queryExtra);
    const hasMore = users.length > params.limit;
    const page = users.slice(0, params.limit);
    const nextCursor =
      hasMore && page.length > 0
        ? encodeCursor((page[page.length - 1] as any).createdAt.toISOString(), (page[page.length - 1] as any).id)
        : null;
    return {
      items: page.map((u: any) => ({
        ...mapUser(u),
        conversationCount: convCounts.get(u.id) ?? 0,
        messageCount: msgCounts.get(u.id) ?? 0,
      })),
      nextCursor,
      hasMore,
    };
  }

  async search(q: string, limit: number): Promise<PublicUserSummary[]> {
    const p = await db();
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const users = await p.user.findMany({
      where: {
        status: 'active',
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { emailNormalized: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { name: 'asc' },
    });
    return (users as any[]).map((u: any) => ({
      id: u.id,
      name: u.name,
      photoUrl: u.photoUrl,
      presence: 'offline' as const,
    }));
  }

  async countByStatus() {
    const p = await db();
    const [total, active, disabled] = await Promise.all([
      p.user.count(),
      p.user.count({ where: { status: 'active' } }),
      p.user.count({ where: { status: 'disabled' } }),
    ]);
    return { total, active, disabled };
  }

  async touchLogin(userId: string, at: Timestamp): Promise<void> {
    const p = await db();
    await p.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(at) } });
  }
}

// Conversation and other repos are implemented below with `any` typed prisma.
// To keep the code tractable, I implement a pragmatic subset that satisfies the
// DataProvider interface using a pattern similar to the memory provider.

class PrismaConversations implements ConversationRepo {
  async findByParticipantKey(key: string): Promise<Conversation | null> {
    const p = await db();
    const row = await p.conversation.findUnique({
      where: { participantKey: key },
      include: { members: true },
    });
    return row ? mapConversation(row, []) : null;
  }
  async getById(conversationId: string): Promise<Conversation | null> {
    const p = await db();
    const row = await p.conversation.findUnique({
      where: { id: conversationId },
      include: { members: true },
    });
    return row ? mapConversation(row, []) : null;
  }
  async create(conversation: Conversation): Promise<Conversation> {
    const p = await db();
    const created = await p.conversation.create({
      data: {
        id: conversation.id,
        participantKey: conversation.participantKey,
        participantIds: conversation.participantIds,
        lastMessageText: conversation.lastMessage?.text ?? null,
        lastMessageAt: conversation.lastMessageAt ? new Date(conversation.lastMessageAt) : null,
        lastActivityAt: new Date(conversation.lastActivityAt),
        members: {
          create: conversation.participantIds.map((uid: string) => {
            const state = conversation.participants[uid];
            return {
              userId: uid,
              lastReadAt: state?.lastReadAt ? new Date(state.lastReadAt) : null,
              unreadCount: state?.unreadCount ?? 0,
              hidden: state?.hidden ?? false,
              hiddenAt: state?.hiddenAt ? new Date(state.hiddenAt) : null,
              blockedUserIds: state?.blockedUserIds ?? [],
            };
          }),
        },
      },
      include: { members: true },
    });
    return mapConversation(created, []);
  }
  async update(conversationId: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const p = await db();
    const data: Record<string, unknown> = {};
    if (patch.lastMessageAt !== undefined) data.lastMessageAt = toDateOrNull(patch.lastMessageAt);
    if (patch.lastActivityAt !== undefined) data.lastActivityAt = new Date(patch.lastActivityAt);
    if (patch.lastMessage !== undefined) data.lastMessageText = patch.lastMessage?.text ?? null;
    const row = await p.conversation.update({ where: { id: conversationId }, data, include: { members: true } });
    return mapConversation(row, []);
  }
  async updateParticipant(conversationId: string, userId: string, patch: Partial<ConversationParticipantState>): Promise<Conversation | null> {
    const p = await db();
    const data: Record<string, unknown> = {};
    if (patch.lastReadAt !== undefined) data.lastReadAt = patch.lastReadAt ? new Date(patch.lastReadAt) : null;
    if (patch.unreadCount !== undefined) data.unreadCount = patch.unreadCount;
    if (patch.hidden !== undefined) data.hidden = patch.hidden;
    if (patch.hiddenAt !== undefined) data.hiddenAt = patch.hiddenAt ? new Date(patch.hiddenAt) : null;
    if (patch.blockedUserIds !== undefined) data.blockedUserIds = patch.blockedUserIds;
    await p.conversationMember.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      update: data,
      create: {
        conversationId,
        userId,
        lastReadAt: patch.lastReadAt ? new Date(patch.lastReadAt) : null,
        unreadCount: patch.unreadCount ?? 0,
        hidden: patch.hidden ?? false,
        hiddenAt: patch.hiddenAt ? new Date(patch.hiddenAt) : null,
        blockedUserIds: patch.blockedUserIds ?? [],
      },
    });
    return this.getById(conversationId);
  }
  async list(params: ListConversationsParams): Promise<Cursor<Conversation>> {
    const p = await db();
    const memberRows = await p.conversationMember.findMany({
      where: { userId: params.userId, hidden: params.includeHidden ? undefined : false },
      include: { conversation: { include: { members: true } } },
      orderBy: { conversation: { lastActivityAt: 'desc' } },
      take: params.limit + 1,
    });
    const convs = memberRows.map((m: any) => mapConversation(m.conversation, []));
    let filtered = convs;
    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      if (c) {
        filtered = convs.filter((conv: Conversation) => {
          const ms = new Date(conv.lastActivityAt).getTime();
          return ms < c.createdAtMs || (ms === c.createdAtMs && conv.id > c.id);
        });
      }
    }
    const hasMore = filtered.length > params.limit;
    const page = filtered.slice(0, params.limit);
    const nextCursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.lastActivityAt, page[page.length - 1]!.id) : null;
    return { items: page, nextCursor, hasMore };
  }
  async countAll(): Promise<number> {
    const p = await db();
    return p.conversation.count();
  }
}

function mapConversation(row: any, _messages: any[]): Conversation {
  const participants: Record<string, ConversationParticipantState> = {};
  for (const m of (row.members ?? []) as any[]) {
    participants[m.userId] = {
      lastReadAt: iso(m.lastReadAt),
      lastReadMessageAt: null,
      unreadCount: m.unreadCount,
      hidden: m.hidden,
      hiddenAt: iso(m.hiddenAt),
      blockedUserIds: [...m.blockedUserIds],
    };
  }
  return {
    id: row.id,
    participantIds: row.participantIds as [string, string],
    participantKey: row.participantKey,
    lastMessage: row.lastMessageText
      ? {
          messageId: '',
          senderId: '',
          type: 'text' as MessageType,
          text: row.lastMessageText,
          deleted: false,
          createdAt: iso(row.lastMessageAt) ?? requiredIso(row.lastActivityAt),
        }
      : null,
    lastActivityAt: requiredIso(row.lastActivityAt),
    lastMessageAt: iso(row.lastMessageAt),
    participants,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Messages, Media, Calls — minimal implementations to satisfy the interface.
// Full mapping is provided where it's straightforward.
// ---------------------------------------------------------------------------

function mapMedia(row: any): Media {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  return {
    id: row.id,
    ownerId: row.ownerId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    kind: row.kind as MediaKind,
    storagePath: row.objectKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: (meta.width as number | null) ?? null,
    height: (meta.height as number | null) ?? null,
    durationMs: (meta.durationMs as number | null) ?? null,
    checksum: row.sha256 ?? '',
    viewOnce: row.viewOnce,
    viewOnceState: (row.viewOnceState ?? null) as ViewOnceState | null,
    viewedAt: iso(row.viewedAt),
    viewedBy: row.viewedBy,
    deleted: row.deleted,
    deletedAt: iso(row.deletedAt),
    deletedBy: (meta.deletedBy as string | null) ?? null,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

function mapMessage(row: any, _opts: { includeHidden?: boolean } = {}): Message {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  const deliveredReceipt = (row.receipts ?? []).find((r: any) => r.status === 'delivered');
  const readReceipts = (row.receipts ?? []).filter((r: any) => r.status === 'read');
  const firstRead = (readReceipts as any[]).reduce((acc: Date | null, r: any) => {
    if (!r.readAt) return acc;
    if (!acc) return r.readAt;
    return r.readAt.getTime() < acc.getTime() ? r.readAt : acc;
  }, null as Date | null);
  let state: Message['deliveryState'] = 'sent';
  if (readReceipts.length > 0) state = 'read';
  else if (deliveredReceipt) state = 'delivered';
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.kind as MessageType,
    text: row.text,
    media: null,
    call: null,
    replyTo: (meta.replyTo as Message['replyTo']) ?? null,
    deliveryState: state,
    deliveredAt: deliveredReceipt ? iso(deliveredReceipt.deliveredAt) : null,
    readBy: readReceipts.map((r: any) => r.userId),
    readAt: iso(firstRead),
    edited: row.edited,
    editedAt: row.edited ? requiredIso(row.updatedAt) : null,
    editHistory: (row.edits ?? []).map((e: any) => ({
      previousText: e.previousText,
      editedAt: requiredIso(e.createdAt),
      editedBy: e.actorId,
    })),
    deleted: row.deleted,
    deletedAt: iso(row.deletedAt),
    deletedBy: row.deletedBy,
    hiddenForUserIds: (meta.hiddenForUserIds as string[]) ?? [],
    clientMessageId: row.clientMessageId,
    expiresAt: (row.expiresAt as Date | null) ? iso(row.expiresAt as Date) : null,
    metadata: meta,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

function mapCall(row: any): Call {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  return {
    id: row.id,
    conversationId: row.conversationId,
    initiatorId: row.initiatorId,
    recipientId: row.recipientId,
    type: row.kind as Call['type'],
    status: row.status as CallStatus,
    startedAt: iso(row.startedAt),
    answeredAt: iso(row.answeredAt),
    endedAt: iso(row.endedAt),
    durationMs: row.durationMs,
    endReason: row.endReason as Call['endReason'],
    diagnostics: {
      iceState: (meta.iceState as string | null) ?? null,
      connectionState: (meta.connectionState as string | null) ?? null,
      turnUsed: (meta.turnUsed as boolean | null) ?? null,
    },
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

class PrismaMessages implements MessageRepo {
  async create(message: Message): Promise<Message> {
    const p = await db();
    const meta = { ...message.metadata };
    if (message.hiddenForUserIds.length) meta.hiddenForUserIds = message.hiddenForUserIds;
    if (message.replyTo) meta.replyTo = message.replyTo;
    const created = await p.message.create({
      data: {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        clientMessageId: message.clientMessageId ?? newId('cmsg'),
        kind: message.type,
        text: message.text,
        metadata: meta,
        edited: message.edited,
        deleted: message.deleted,
        deletedAt: message.deletedAt ? new Date(message.deletedAt) : null,
        deletedBy: message.deletedBy,
        expiresAt: message.expiresAt ? new Date(message.expiresAt) : null,
      },
      include: { edits: true, media: true, receipts: true },
    });
    return mapMessage(created);
  }
  async getById(messageId: string): Promise<Message | null> {
    const p = await db();
    const row = await p.message.findUnique({ where: { id: messageId }, include: { edits: true, media: true, receipts: true } });
    return row ? mapMessage(row) : null;
  }
  async findByClientMessageId(params: { conversationId: string; senderId: string; clientMessageId: string }): Promise<Message | null> {
    const p = await db();
    const row = await p.message.findUnique({
      where: {
        conversationId_senderId_clientMessageId: {
          conversationId: params.conversationId,
          senderId: params.senderId,
          clientMessageId: params.clientMessageId,
        },
      },
      include: { edits: true, media: true, receipts: true },
    });
    return row ? mapMessage(row) : null;
  }
  async list(params: ListMessagesParams): Promise<Cursor<Message>> {
    const p = await db();
    const where: Record<string, unknown> = { conversationId: params.conversationId };
    if (!params.includeDeleted) where.deleted = false;
    if (params.before) where.createdAt = { lt: new Date(params.before) };
    if (params.after) where.createdAt = { gt: new Date(params.after) };
    if (params.q) where.text = { contains: params.q, mode: 'insensitive' };
    const orderBy = params.after ? { createdAt: 'asc' } : { createdAt: 'desc' };
    const queryExtra: Record<string, unknown> = {
      where,
      orderBy,
      take: params.limit + 1,
      include: { edits: true, media: true, receipts: true },
    };
    if (params.cursor && !params.after) {
      const c = decodeCursor(params.cursor);
      if (c) Object.assign(queryExtra, { cursor: { createdAt: new Date(c.createdAtMs), id: c.id }, skip: 1 });
    }
    const rows = await p.message.findMany(queryExtra);
    const hasMore = rows.length > params.limit;
    const page = rows.slice(0, params.limit);
    const nextCursor =
      hasMore && page.length > 0 && !params.after
        ? encodeCursor((page[page.length - 1] as any).createdAt.toISOString(), (page[page.length - 1] as any).id)
        : null;
    return { items: page.map(mapMessage), nextCursor, hasMore: params.after ? false : hasMore };
  }
  async update(messageId: string, patch: Partial<Message>): Promise<Message | null> {
    const p = await db();
    const data: Record<string, unknown> = {};
    if (patch.text !== undefined) data.text = patch.text;
    if (patch.edited !== undefined) data.edited = patch.edited;
    if (patch.deleted !== undefined) data.deleted = patch.deleted;
    if (patch.deletedAt !== undefined) data.deletedAt = patch.deletedAt ? new Date(patch.deletedAt) : null;
    if (patch.deletedBy !== undefined) data.deletedBy = patch.deletedBy;
    if (patch.metadata !== undefined) data.metadata = patch.metadata;
    if (patch.editHistory && patch.editHistory.length > 0) {
      const latest = patch.editHistory[patch.editHistory.length - 1]!;
      data.edits = { create: { actorId: latest.editedBy, previousText: latest.previousText } };
    }
    const row = await p.message.update({ where: { id: messageId }, data, include: { edits: true, media: true, receipts: true } });
    return mapMessage(row);
  }
  async countForConversation(conversationId: string): Promise<number> {
    const p = await db();
    return p.message.count({ where: { conversationId } });
  }
  async countAll() {
    const p = await db();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [total, deleted, last24h] = await Promise.all([
      p.message.count(),
      p.message.count({ where: { deleted: true } }),
      p.message.count({ where: { createdAt: { gt: cutoff } } }),
    ]);
    return { total, deleted, last24h };
  }
  async listForUser(userId: string, limit: number): Promise<Cursor<Message>> {
    const p = await db();
    const rows = await p.message.findMany({ where: { senderId: userId }, orderBy: { createdAt: 'desc' }, take: limit, include: { edits: true, media: true, receipts: true } });
    return { items: rows.map(mapMessage), nextCursor: null, hasMore: false };
  }
  async listRecent(limit: number): Promise<Message[]> {
    const p = await db();
    const rows = await p.message.findMany({ orderBy: { createdAt: 'desc' }, take: limit, include: { edits: true, media: true, receipts: true } });
    return rows.map(mapMessage);
  }
}

class PrismaMedia implements MediaRepo {
  async create(media: Media): Promise<Media> {
    const p = await db();
    const meta: Record<string, unknown> = {};
    if (media.width != null) meta.width = media.width;
    if (media.height != null) meta.height = media.height;
    if (media.durationMs != null) meta.durationMs = media.durationMs;
    if (media.deletedBy != null) meta.deletedBy = media.deletedBy;
    const created = await p.mediaObject.create({
      data: {
        id: media.id,
        ownerId: media.ownerId,
        conversationId: media.conversationId!,
        messageId: media.messageId,
        objectKey: media.storagePath,
        bucket: process.env.STORAGE_BUCKET ?? 'keypad-media',
        provider: process.env.STORAGE_PROVIDER === 's3' ? 's3' : 'local',
        kind: media.kind,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        sha256: media.checksum || null,
        uploadState: 'ready',
        viewOnce: media.viewOnce,
        viewOnceState: media.viewOnceState,
        viewedAt: media.viewedAt ? new Date(media.viewedAt) : null,
        viewedBy: media.viewedBy,
        deleted: media.deleted,
        deletedAt: media.deletedAt ? new Date(media.deletedAt) : null,
        metadata: meta,
      },
    });
    return mapMedia(created);
  }
  async getById(mediaId: string): Promise<Media | null> {
    const p = await db();
    const row = await p.mediaObject.findUnique({ where: { id: mediaId } });
    return row ? mapMedia(row) : null;
  }
  async update(mediaId: string, patch: Partial<Media>): Promise<Media | null> {
    const p = await db();
    const data: Record<string, unknown> = {};
    if (patch.mimeType !== undefined) data.mimeType = patch.mimeType;
    if (patch.sizeBytes !== undefined) data.sizeBytes = patch.sizeBytes;
    if (patch.viewOnce !== undefined) data.viewOnce = patch.viewOnce;
    if (patch.viewOnceState !== undefined) data.viewOnceState = patch.viewOnceState;
    if (patch.viewedAt !== undefined) data.viewedAt = patch.viewedAt ? new Date(patch.viewedAt) : null;
    if (patch.viewedBy !== undefined) data.viewedBy = patch.viewedBy;
    if (patch.deleted !== undefined) data.deleted = patch.deleted;
    if (patch.deletedAt !== undefined) data.deletedAt = patch.deletedAt ? new Date(patch.deletedAt) : null;
    if (patch.messageId !== undefined) data.messageId = patch.messageId;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if ((patch as any).uploadState !== undefined) data.uploadState = (patch as any).uploadState;
    const row = await p.mediaObject.update({ where: { id: mediaId }, data });
    return mapMedia(row);
  }
  async list(params: ListMediaParams): Promise<Cursor<Media>> {
    const p = await db();
    const where: Record<string, unknown> = {};
    if (!params.includeDeleted) where.deleted = false;
    if (params.kind) where.kind = params.kind;
    if (params.viewOnceOnly) where.viewOnce = true;
    const rows = await p.mediaObject.findMany({ where, orderBy: { createdAt: 'desc' }, take: params.limit + 1 });
    const hasMore = rows.length > params.limit;
    const page = rows.slice(0, params.limit);
    const nextCursor = hasMore && page.length > 0 ? encodeCursor((page[page.length - 1] as any).createdAt.toISOString(), (page[page.length - 1] as any).id) : null;
    return { items: page.map(mapMedia), nextCursor, hasMore };
  }
  async listForConversation(conversationId: string): Promise<Media[]> {
    const p = await db();
    const rows = await p.mediaObject.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' } });
    return rows.map(mapMedia);
  }
  async claimViewOnce(mediaId: string, viewerId: string): Promise<ViewOnceClaim> {
    const p = await db();
    try {
      const result = await p.$transaction(async (tx: any) => {
        const media = await tx.mediaObject.findUnique({ where: { id: mediaId } });
        if (!media || media.deleted) return { media, claimed: false };
        if (media.ownerId === viewerId) return { media, claimed: false };
        if (media.viewOnceState !== VO.Delivered && media.viewOnceState !== VO.Viewable) return { media, claimed: false };
        const updated = await tx.mediaObject.update({ where: { id: mediaId }, data: { viewOnceState: VO.Viewing } });
        return { media: updated, claimed: true };
      });
      return { media: result.media ? mapMedia(result.media) : null, claimed: result.claimed };
    } catch {
      return { media: await this.getById(mediaId), claimed: false };
    }
  }
  async markViewed(mediaId: string, viewerId: string): Promise<Media | null> {
    const p = await db();
    const row = await p.mediaObject.update({
      where: { id: mediaId },
      data: { viewOnceState: VO.Viewed, viewedAt: new Date(), viewedBy: viewerId },
    });
    return mapMedia(row);
  }
  async countAll() {
    const p = await db();
    const [total, viewOnce, deleted] = await Promise.all([
      p.mediaObject.count(),
      p.mediaObject.count({ where: { viewOnce: true } }),
      p.mediaObject.count({ where: { deleted: true } }),
    ]);
    return { total, viewOnce, deleted };
  }
}

class PrismaCalls implements CallRepo {
  async create(call: Call): Promise<Call> {
    const p = await db();
    const meta = { iceState: call.diagnostics.iceState, connectionState: call.diagnostics.connectionState, turnUsed: call.diagnostics.turnUsed };
    const created = await p.call.create({
      data: {
        id: call.id,
        conversationId: call.conversationId,
        initiatorId: call.initiatorId,
        recipientId: call.recipientId,
        kind: call.type,
        status: call.status,
        endReason: call.endReason,
        startedAt: call.startedAt ? new Date(call.startedAt) : new Date(),
        answeredAt: call.answeredAt ? new Date(call.answeredAt) : null,
        endedAt: call.endedAt ? new Date(call.endedAt) : null,
        durationMs: call.durationMs,
        metadata: meta,
      },
    });
    return mapCall(created);
  }
  async getById(callId: string): Promise<Call | null> {
    const p = await db();
    const row = await p.call.findUnique({ where: { id: callId } });
    return row ? mapCall(row) : null;
  }
  async update(callId: string, patch: Partial<Call>): Promise<Call | null> {
    const p = await db();
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.endReason !== undefined) data.endReason = patch.endReason;
    if (patch.answeredAt !== undefined) data.answeredAt = toDateOrNull(patch.answeredAt);
    if (patch.endedAt !== undefined) data.endedAt = toDateOrNull(patch.endedAt);
    if (patch.durationMs !== undefined) data.durationMs = patch.durationMs;
    if (patch.startedAt !== undefined) data.startedAt = patch.startedAt ? new Date(patch.startedAt) : null;
    if (patch.diagnostics) {
      const existing = await p.call.findUnique({ where: { id: callId } });
      const prevMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
      data.metadata = { ...prevMeta, ...patch.diagnostics };
    }
    const row = await p.call.update({ where: { id: callId }, data });
    return mapCall(row);
  }
  async list(params: ListCallsParams): Promise<Cursor<Call>> {
    const p = await db();
    const where: Record<string, unknown> = {};
    if (params.conversationId) where.conversationId = params.conversationId;
    if (params.userId) where.OR = [{ initiatorId: params.userId }, { recipientId: params.userId }];
    const rows = await p.call.findMany({ where, orderBy: { startedAt: 'desc' }, take: params.limit + 1 });
    const hasMore = rows.length > params.limit;
    const page = rows.slice(0, params.limit);
    const nextCursor = hasMore && page.length > 0 ? encodeCursor((page[page.length - 1] as any).startedAt.toISOString(), (page[page.length - 1] as any).id) : null;
    return { items: page.map(mapCall), nextCursor, hasMore };
  }
  async findActiveForConversation(conversationId: string): Promise<Call | null> {
    const p = await db();
    const row = await p.call.findFirst({
      where: { conversationId, status: { in: ['ringing', 'accepted', 'active'] } },
      orderBy: { startedAt: 'desc' },
    });
    return row ? mapCall(row) : null;
  }
  async findRingingForUser(userId: string): Promise<Call | null> {
    const p = await db();
    const row = await p.call.findFirst({ where: { recipientId: userId, status: 'ringing' }, orderBy: { startedAt: 'desc' } });
    return row ? mapCall(row) : null;
  }
  async countAll(): Promise<number> {
    const p = await db();
    return p.call.count();
  }
}

class PrismaConfig implements ConfigRepo {
  async getAccessConfig(): Promise<AccessConfigRecord> {
    const p = await db();
    const existing = await p.secretCodeConfiguration.findUnique({ where: { id: 1 } });
    if (existing) {
      return {
        code: existing.codePlaintext,
        digest: existing.codeHash,
        salt: existing.codeSalt,
        maxLength: existing.maxLength,
        caseSensitive: existing.caseSensitive,
        epoch: existing.epoch,
        unlockCount: existing.unlockCount,
        updatedAt: iso(existing.updatedAt),
        updatedBy: existing.updatedById,
        createdAt: requiredIso(existing.createdAt),
      };
    }
    const created = await p.secretCodeConfiguration.create({
      data: { id: 1, codePlaintext: '', codeHash: '', codeSalt: newId('salt'), maxLength: 15, caseSensitive: true, epoch: 1, unlockCount: 0 },
    });
    return {
      code: created.codePlaintext,
      digest: created.codeHash,
      salt: created.codeSalt,
      maxLength: created.maxLength,
      caseSensitive: created.caseSensitive,
      epoch: created.epoch,
      unlockCount: created.unlockCount,
      updatedAt: iso(created.updatedAt),
      updatedBy: created.updatedById,
      createdAt: requiredIso(created.createdAt),
    };
  }
  async setAccessConfig(patch: Partial<AccessConfigRecord>): Promise<AccessConfigRecord> {
    const p = await db();
    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.code !== undefined) data.codePlaintext = patch.code;
    if (patch.digest !== undefined) data.codeHash = patch.digest;
    if (patch.salt !== undefined) data.codeSalt = patch.salt;
    if (patch.maxLength !== undefined) data.maxLength = patch.maxLength;
    if (patch.caseSensitive !== undefined) data.caseSensitive = patch.caseSensitive;
    if (patch.epoch !== undefined) data.epoch = patch.epoch;
    if (patch.unlockCount !== undefined) data.unlockCount = patch.unlockCount;
    if (patch.updatedBy !== undefined) data.updatedById = patch.updatedBy;
    const row = await p.secretCodeConfiguration.upsert({
      where: { id: 1 },
      update: data,
      create: {
        id: 1,
        codePlaintext: patch.code ?? '',
        codeHash: patch.digest ?? '',
        codeSalt: patch.salt ?? newId('salt'),
        maxLength: patch.maxLength ?? 15,
        caseSensitive: patch.caseSensitive ?? true,
        epoch: patch.epoch ?? 1,
        unlockCount: patch.unlockCount ?? 0,
        updatedById: patch.updatedBy,
      },
    });
    return {
      code: row.codePlaintext,
      digest: row.codeHash,
      salt: row.codeSalt,
      maxLength: row.maxLength,
      caseSensitive: row.caseSensitive,
      epoch: row.epoch,
      unlockCount: row.unlockCount,
      updatedAt: iso(row.updatedAt),
      updatedBy: row.updatedById,
      createdAt: requiredIso(row.createdAt),
    };
  }
  async incrementUnlockCount(): Promise<AccessConfigRecord> {
    const p = await db();
    await p.secretCodeConfiguration.update({ where: { id: 1 }, data: { unlockCount: { increment: 1 } } });
    return this.getAccessConfig();
  }
}

class PrismaAudit implements AuditRepo {
  async append(entry: AuditLogEntry): Promise<AuditLogEntry> {
    const p = await db();
    const created = await p.auditLog.create({
      data: {
        id: entry.id,
        actorId: entry.actorUid,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? {},
        ip: entry.ipAddress ?? null,
      },
      include: { actor: true },
    });
    return {
      ...entry,
      id: created.id,
      actorEmail: created.actor?.email ?? null,
      createdAt: requiredIso(created.createdAt),
      updatedAt: requiredIso(created.updatedAt ?? created.createdAt),
    };
  }
  async list(params: ListAuditParams): Promise<Cursor<AuditLogEntry>> {
    const p = await db();
    const where: Record<string, unknown> = {};
    if (params.action) where.action = params.action;
    if (params.actorUid) where.actorId = params.actorUid;
    const rows = await p.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: params.limit + 1, include: { actor: true } });
    const hasMore = rows.length > params.limit;
    const page = rows.slice(0, params.limit);
    const nextCursor = hasMore && page.length > 0 ? encodeCursor((page[page.length - 1] as any).createdAt.toISOString(), (page[page.length - 1] as any).id) : null;
    return {
      items: page.map((r: any) => ({
        id: r.id,
        actorUid: r.actorId,
        actorEmail: r.actor?.email ?? null,
        action: r.action,
        targetType: r.targetType ?? '',
        targetId: r.targetId,
        metadata: r.metadata ?? {},
        ipAddress: r.ip,
        createdAt: requiredIso(r.createdAt),
        updatedAt: requiredIso(r.updatedAt ?? r.createdAt),
      })),
      nextCursor,
      hasMore,
    };
  }
}

class PrismaTypingSessions implements TypingSessionRepo {
  async create(session: TypingSession): Promise<TypingSession> {
    const p = await db();
    const created = await p.typingSession.create({
      data: {
        id: session.id,
        userId: session.userId,
        resultJson: session.result as unknown as Record<string, unknown>,
        attemptsJson: session.attempts as unknown as unknown[],
      },
    });
    return {
      id: created.id,
      userId: created.userId,
      result: (created.resultJson as unknown) as TypingSession['result'],
      attempts: (created.attemptsJson as unknown) as TypingSession['attempts'],
      createdAt: requiredIso(created.createdAt),
      updatedAt: requiredIso(created.updatedAt),
    };
  }
  async countAll(): Promise<number> {
    const p = await db();
    return p.typingSession.count();
  }
  async listRecent(limit: number): Promise<TypingSession[]> {
    const p = await db();
    const rows = await p.typingSession.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((r: any) => ({
      id: r.id,
      userId: r.userId,
      result: r.resultJson as TypingSession['result'],
      attempts: r.attemptsJson as TypingSession['attempts'],
      createdAt: requiredIso(r.createdAt),
      updatedAt: requiredIso(r.updatedAt),
    }));
  }
}

class PrismaOutbox implements OutboxRepo {
  async enqueue(input: { id: string; userId: string; topic: string; type: string; payload: unknown; createdAt: Date }): Promise<OutboxEventRecord> {
    const p = await db();
    const created = await p.outboxEvent.create({
      data: {
        id: input.id,
        userId: input.userId,
        topic: input.topic,
        type: input.type,
        payload: input.payload as Record<string, unknown>,
        createdAt: input.createdAt,
      },
    });
    return { id: created.id, userId: created.userId, topic: created.topic, type: created.type, payload: created.payload, createdAt: created.createdAt, deliveredAt: created.deliveredAt };
  }
  async listForUser(userId: string, afterId: string | null, limit: number): Promise<OutboxEventRecord[]> {
    const p = await db();
    const where: Record<string, unknown> = { userId };
    if (afterId) where.id = { gt: afterId };
    const rows = await p.outboxEvent.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit });
    return (rows as any[]).map((r) => ({ id: r.id, userId: r.userId, topic: r.topic, type: r.type, payload: r.payload, createdAt: r.createdAt, deliveredAt: r.deliveredAt }));
  }
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const p = await db();
    await p.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { deliveredAt: new Date() } });
  }
  async claimPending(limit: number): Promise<OutboxEventRecord[]> {
    const p = await db();
    const rows = await p.outboxEvent.findMany({ where: { deliveredAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit });
    return (rows as any[]).map((r) => ({ id: r.id, userId: r.userId, topic: r.topic, type: r.type, payload: r.payload, createdAt: r.createdAt, deliveredAt: r.deliveredAt }));
  }
}

export function createPrismaDataProvider(): DataProvider {
  return {
    name: 'prisma',
    users: new PrismaUsers(),
    sessions: new PrismaSessions(),
    conversations: new PrismaConversations(),
    messages: new PrismaMessages(),
    media: new PrismaMedia(),
    calls: new PrismaCalls(),
    config: new PrismaConfig(),
    audit: new PrismaAudit(),
    typingSessions: new PrismaTypingSessions(),
    rateLimits: new PrismaRateLimits(),
    outbox: new PrismaOutbox(),
  };
}

// Unused exports guard
void nowIso;

import type {
  AdminUserRow,
  AuditLogEntry,
  Call,
  Conversation,
  ConversationParticipantState,
  Cursor,
  Media,
  Message,
  PublicUserSummary,
  Timestamp,
  TypingSession,
  ViewOnceState,
} from '@mt/types';
import { ViewOnceState as ViewOnce } from '@mt/types';
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
import { afterCursor, compareNewestFirst, encodeCursor, getStore, paginate, resetStore } from './store';

function nowIso(): Timestamp {
  return new Date().toISOString();
}

function values<T>(map: Map<string, T>): T[] {
  return Array.from(map.values());
}

class MemoryUsers implements UserRepo {
  private get store() {
    return getStore().users as Map<string, UserRecord>;
  }

  async create(record: UserRecord): Promise<UserRecord> {
    if (this.store.has(record.id)) {
      throw new Error(`user ${record.id} already exists`);
    }
    this.store.set(record.id, { ...record });
    return { ...record };
  }

  async getById(userId: string): Promise<UserRecord | null> {
    const record = this.store.get(userId);
    return record ? { ...record } : null;
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    const record = values(this.store).find((user) => user.email.toLowerCase() === normalized);
    return record ? { ...record } : null;
  }

  async update(userId: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const record = this.store.get(userId);
    if (!record) return null;
    const next = { ...record, ...patch, updatedAt: nowIso() };
    this.store.set(userId, next);
    return { ...next };
  }

  async list(params: ListUsersParams): Promise<Cursor<AdminUserRow>> {
    const query = params.q?.trim().toLowerCase();
    const filtered = values(this.store)
      .filter((user) => (params.status ? user.status === params.status : true))
      .filter((user) =>
        query
          ? user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query)
          : true,
      )
      .sort(compareNewestFirst);
    const page = paginate(afterCursor(filtered, params.cursor), params.limit);
    const messages = getStore().messages as Map<string, Message>;
    const conversations = getStore().conversations as Map<string, Conversation>;
    return {
      ...page,
      items: page.items.map((user): AdminUserRow => ({
        ...user,
        conversationCount: values(conversations).filter((conversation) =>
          conversation.participantIds.includes(user.id),
        ).length,
        messageCount: values(messages).filter((message) => message.senderId === user.id).length,
      })),
    };
  }

  async search(q: string, limit: number): Promise<PublicUserSummary[]> {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return values(this.store)
      .filter((user) => user.status === 'active')
      .filter(
        (user) =>
          user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query),
      )
      .slice(0, limit)
      .map((user) => ({
        id: user.id,
        name: user.name,
        photoUrl: user.photoUrl,
        presence: 'offline' as const,
      }));
  }

  async countByStatus(): Promise<{ total: number; active: number; disabled: number }> {
    const all = values(this.store);
    return {
      total: all.length,
      active: all.filter((user) => user.status === 'active').length,
      disabled: all.filter((user) => user.status === 'disabled').length,
    };
  }

  async touchLogin(userId: string, at: Timestamp): Promise<void> {
    const record = this.store.get(userId);
    if (record) this.store.set(userId, { ...record, lastLoginAt: at });
  }
}

class MemoryConversations implements ConversationRepo {
  private get store() {
    return getStore().conversations as Map<string, Conversation>;
  }

  async findByParticipantKey(key: string): Promise<Conversation | null> {
    const found = values(this.store).find((conversation) => conversation.participantKey === key);
    return found ? { ...found } : null;
  }

  async getById(conversationId: string): Promise<Conversation | null> {
    const found = this.store.get(conversationId);
    return found ? { ...found } : null;
  }

  async create(conversation: Conversation): Promise<Conversation> {
    this.store.set(conversation.id, { ...conversation });
    return { ...conversation };
  }

  async update(conversationId: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const current = this.store.get(conversationId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.store.set(conversationId, next);
    return { ...next };
  }

  async updateParticipant(
    conversationId: string,
    userId: string,
    patch: Partial<ConversationParticipantState>,
  ): Promise<Conversation | null> {
    const current = this.store.get(conversationId);
    if (!current) return null;
    const state = current.participants[userId] ?? {
      lastReadAt: null,
      lastReadMessageAt: null,
      unreadCount: 0,
      hidden: false,
      hiddenAt: null,
      blockedUserIds: [],
    };
    const next: Conversation = {
      ...current,
      participants: { ...current.participants, [userId]: { ...state, ...patch } },
      updatedAt: nowIso(),
    };
    this.store.set(conversationId, next);
    return { ...next };
  }

  async list(params: ListConversationsParams): Promise<Cursor<Conversation>> {
    const filtered = values(this.store)
      .filter((conversation) => conversation.participantIds.includes(params.userId))
      .filter((conversation) =>
        params.includeHidden ? true : !conversation.participants[params.userId]?.hidden,
      )
      .sort((a, b) => {
        const delta = new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
        return delta !== 0 ? delta : a.id.localeCompare(b.id);
      });
    const keyOf = (conversation: Conversation) => conversation.lastActivityAt;
    return paginate(afterCursor(filtered, params.cursor, keyOf), params.limit, keyOf);
  }

  async countAll(): Promise<number> {
    return this.store.size;
  }
}

class MemoryMessages implements MessageRepo {
  private get store() {
    return getStore().messages as Map<string, Message>;
  }

  async create(message: Message): Promise<Message> {
    this.store.set(message.id, { ...message });
    return { ...message };
  }

  async getById(messageId: string): Promise<Message | null> {
    const message = this.store.get(messageId);
    return message ? { ...message } : null;
  }

  async findByClientMessageId(params: {
    conversationId: string;
    senderId: string;
    clientMessageId: string;
  }): Promise<Message | null> {
    const found = values(this.store).find(
      (message) =>
        message.conversationId === params.conversationId &&
        message.senderId === params.senderId &&
        message.clientMessageId === params.clientMessageId,
    );
    return found ? { ...found } : null;
  }

  async list(params: ListMessagesParams): Promise<Cursor<Message>> {
    const query = params.q?.trim().toLowerCase();
    let items = values(this.store)
      .filter((message) => message.conversationId === params.conversationId)
      .filter((message) => (params.includeDeleted ? true : !message.deleted))
      .filter((message) =>
        params.before ? new Date(message.createdAt).getTime() < new Date(params.before).getTime() : true,
      )
      .filter((message) =>
        params.after ? new Date(message.createdAt).getTime() > new Date(params.after).getTime() : true,
      )
      .filter((message) =>
        query ? (message.text ?? '').toLowerCase().includes(query) : true,
      )
      .sort(compareNewestFirst);

    if (params.after) {
      // Live tail: oldest first is what the UI appends.
      items = items.reverse();
      return { items: items.slice(0, params.limit), nextCursor: null, hasMore: false };
    }
    return paginate(afterCursor(items, params.cursor), params.limit);
  }

  async update(messageId: string, patch: Partial<Message>): Promise<Message | null> {
    const current = this.store.get(messageId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.store.set(messageId, next);
    return { ...next };
  }

  async countForConversation(conversationId: string): Promise<number> {
    return values(this.store).filter((message) => message.conversationId === conversationId).length;
  }

  async countAll(): Promise<{ total: number; deleted: number; last24h: number }> {
    const all = values(this.store);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return {
      total: all.length,
      deleted: all.filter((message) => message.deleted).length,
      last24h: all.filter((message) => new Date(message.createdAt).getTime() > cutoff).length,
    };
  }

  async listForUser(userId: string, limit: number): Promise<Cursor<Message>> {
    const items = values(this.store)
      .filter((message) => message.senderId === userId)
      .sort(compareNewestFirst);
    return paginate(items, limit);
  }

  async listRecent(limit: number): Promise<Message[]> {
    return values(this.store).sort(compareNewestFirst).slice(0, limit);
  }
}

class MemoryMedia implements MediaRepo {
  private get store() {
    return getStore().media as Map<string, Media>;
  }

  async create(media: Media): Promise<Media> {
    this.store.set(media.id, { ...media });
    return { ...media };
  }

  async getById(mediaId: string): Promise<Media | null> {
    const media = this.store.get(mediaId);
    return media ? { ...media } : null;
  }

  async update(mediaId: string, patch: Partial<Media>): Promise<Media | null> {
    const current = this.store.get(mediaId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.store.set(mediaId, next);
    return { ...next };
  }

  async list(params: ListMediaParams): Promise<Cursor<Media>> {
    const filtered = values(this.store)
      .filter((media) => (params.includeDeleted ? true : !media.deleted))
      .filter((media) => (params.kind ? media.kind === params.kind : true))
      .filter((media) => (params.viewOnceOnly ? media.viewOnce : true))
      .sort(compareNewestFirst);
    return paginate(afterCursor(filtered, params.cursor), params.limit);
  }

  async listForConversation(conversationId: string): Promise<Media[]> {
    return values(this.store)
      .filter((media) => media.conversationId === conversationId)
      .sort(compareNewestFirst);
  }

  /**
   * Atomic by construction here because the map read/write pair is synchronous.
   * The Prisma implementation performs the same transition in a transaction.
   */
  async claimViewOnce(mediaId: string, viewerId: string): Promise<ViewOnceClaim> {
    const media = this.store.get(mediaId);
    if (!media || media.deleted) return { media: media ?? null, claimed: false };
    const state = media.viewOnceState as ViewOnceState | null;
    const canClaim = state === ViewOnce.Delivered || state === ViewOnce.Viewable;
    if (!canClaim || media.ownerId === viewerId) {
      return { media: { ...media }, claimed: false };
    }
    const next: Media = { ...media, viewOnceState: ViewOnce.Viewing, updatedAt: nowIso() };
    this.store.set(mediaId, next);
    return { media: { ...next }, claimed: true };
  }

  async markViewed(mediaId: string, viewerId: string): Promise<Media | null> {
    const media = this.store.get(mediaId);
    if (!media) return null;
    const next: Media = {
      ...media,
      viewOnceState: ViewOnce.Viewed,
      viewedAt: nowIso(),
      viewedBy: viewerId,
      updatedAt: nowIso(),
    };
    this.store.set(mediaId, next);
    return { ...next };
  }

  async countAll(): Promise<{ total: number; viewOnce: number; deleted: number }> {
    const all = values(this.store);
    return {
      total: all.length,
      viewOnce: all.filter((media) => media.viewOnce).length,
      deleted: all.filter((media) => media.deleted).length,
    };
  }
}

class MemoryCalls implements CallRepo {
  private get store() {
    return getStore().calls as Map<string, Call>;
  }

  async create(call: Call): Promise<Call> {
    this.store.set(call.id, { ...call });
    return { ...call };
  }

  async getById(callId: string): Promise<Call | null> {
    const call = this.store.get(callId);
    return call ? { ...call } : null;
  }

  async update(callId: string, patch: Partial<Call>): Promise<Call | null> {
    const current = this.store.get(callId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.store.set(callId, next);
    return { ...next };
  }

  async list(params: ListCallsParams): Promise<Cursor<Call>> {
    const filtered = values(this.store)
      .filter((call) => (params.conversationId ? call.conversationId === params.conversationId : true))
      .filter((call) =>
        params.userId ? call.initiatorId === params.userId || call.recipientId === params.userId : true,
      )
      .sort(compareNewestFirst);
    return paginate(afterCursor(filtered, params.cursor), params.limit);
  }

  async findActiveForConversation(conversationId: string): Promise<Call | null> {
    const active = values(this.store).find(
      (call) =>
        call.conversationId === conversationId &&
        (call.status === 'ringing' || call.status === 'accepted' || call.status === 'active'),
    );
    return active ? { ...active } : null;
  }

  async findRingingForUser(userId: string): Promise<Call | null> {
    const ringing = values(this.store).find(
      (call) => call.recipientId === userId && call.status === 'ringing',
    );
    return ringing ? { ...ringing } : null;
  }

  async countAll(): Promise<number> {
    return this.store.size;
  }
}

class MemoryConfig implements ConfigRepo {
  async getAccessConfig(): Promise<AccessConfigRecord> {
    const store = getStore();
    // Mirrors the Prisma provider: a fresh store returns an unconfigured
    // record instead of failing, so `ensureAccessConfig()` can seed the code.
    if (!store.accessConfig) {
      const created = createDefaultConfig();
      store.accessConfig = created;
      return { ...created };
    }
    return { ...(store.accessConfig as AccessConfigRecord) };
  }

  async setAccessConfig(patch: Partial<AccessConfigRecord>): Promise<AccessConfigRecord> {
    const store = getStore();
    const current = (store.accessConfig as AccessConfigRecord | null) ?? createDefaultConfig();
    const next = { ...current, ...patch };
    store.accessConfig = next;
    return { ...next };
  }

  async incrementUnlockCount(): Promise<AccessConfigRecord> {
    const current = await this.getAccessConfig();
    return this.setAccessConfig({ unlockCount: current.unlockCount + 1 });
  }
}

function createDefaultConfig(): AccessConfigRecord {
  return {
    code: '',
    digest: '',
    salt: newId('salt'),
    maxLength: 15,
    caseSensitive: true,
    epoch: 1,
    unlockCount: 0,
    updatedAt: null,
    updatedBy: null,
    createdAt: nowIso(),
  };
}

class MemoryAudit implements AuditRepo {
  private get store() {
    return getStore().auditLogs as AuditLogEntry[];
  }

  async append(entry: AuditLogEntry): Promise<AuditLogEntry> {
    this.store.unshift({ ...entry });
    return { ...entry };
  }

  async list(params: ListAuditParams): Promise<Cursor<AuditLogEntry>> {
    const filtered = this.store
      .filter((entry) => (params.action ? entry.action === params.action : true))
      .filter((entry) => (params.actorUid ? entry.actorUid === params.actorUid : true))
      .sort(compareNewestFirst);
    return paginate(afterCursor(filtered, params.cursor), params.limit);
  }
}

class MemoryTypingSessions implements TypingSessionRepo {
  private get store() {
    return getStore().typingSessions as TypingSession[];
  }

  async create(session: TypingSession): Promise<TypingSession> {
    this.store.unshift({ ...session });
    return { ...session };
  }

  async countAll(): Promise<number> {
    return this.store.length;
  }

  async listRecent(limit: number): Promise<TypingSession[]> {
    return this.store.slice(0, limit);
  }
}

class MemorySessions implements SessionRepo {
  private get store() {
    return getStore().sessions as Map<string, SessionRecord>;
  }

  async create(input: {
    id: string; userId: string; tokenHash: string; userAgent: string | null; ip: string | null;
    createdAt: Date; lastActiveAt: Date; expiresAt: Date;
  }): Promise<SessionRecord> {
    const rec: SessionRecord = { ...input, revokedAt: null };
    this.store.set(rec.id, rec);
    return { ...rec };
  }

  async findByTokenHash(tokenHash: string): Promise<(SessionRecord & { user: SessionUserJoin }) | null> {
    const found = Array.from(this.store.values()).find((s) => s.tokenHash === tokenHash);
    if (!found) return null;
    const users = getStore().users as Map<string, UserRecord & { disabled?: boolean }>;
    const user = users.get(found.userId);
    if (!user) return null;
    return { ...found, user: { id: user.id, email: user.email, name: user.name, disabled: user.status === 'disabled' } };
  }

  async touch(id: string, lastActiveAt: Date): Promise<void> {
    const s = this.store.get(id);
    if (s) { s.lastActiveAt = lastActiveAt; }
  }

  async revokeByTokenHash(tokenHash: string): Promise<void> {
    const found = Array.from(this.store.values()).find((s) => s.tokenHash === tokenHash);
    if (found) found.revokedAt = new Date();
  }

  async revokeAllForUser(userId: string): Promise<number> {
    let n = 0;
    for (const s of this.store.values()) {
      if (s.userId === userId && !s.revokedAt) { s.revokedAt = new Date(); n++; }
    }
    return n;
  }
}

class MemoryOutbox implements OutboxRepo {
  private get store() { return getStore().outbox as OutboxEventRecord[]; }
  async enqueue(input: { id: string; userId: string; topic: string; type: string; payload: unknown; createdAt: Date }): Promise<OutboxEventRecord> {
    const rec: OutboxEventRecord = { ...input, deliveredAt: null };
    this.store.push(rec);
    return rec;
  }
  async listForUser(userId: string, afterId: string | null, limit: number): Promise<OutboxEventRecord[]> {
    let items = this.store.filter((e) => e.userId === userId);
    if (afterId) items = items.filter((e) => e.id > afterId);
    items.sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.id.localeCompare(b.id));
    return items.slice(0, limit);
  }
  async markDelivered(ids: string[]): Promise<void> {
    const set = new Set(ids);
    for (const e of this.store) if (set.has(e.id)) e.deliveredAt = new Date();
  }
  async claimPending(limit: number): Promise<OutboxEventRecord[]> {
    const pending = this.store.filter((e) => e.deliveredAt === null).slice(0, limit);
    return pending;
  }
}

class MemoryRateLimits implements RateLimitRepo {
  async consume(key: string, options: { limit: number; windowMs: number }) {
    const buckets = getStore().rateLimits;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return { allowed: true, remaining: options.limit - 1, resetAt: now + options.windowMs, retryAfterSeconds: 0 };
    }
    bucket.count += 1;
    const allowed = bucket.count <= options.limit;
    const retryAfterSeconds = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
    return {
      allowed,
      remaining: Math.max(0, options.limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds,
    };
  }
}

export function createMemoryDataProvider(): DataProvider {
  return {
    name: 'memory',
    users: new MemoryUsers(),
    sessions: new MemorySessions(),
    conversations: new MemoryConversations(),
    messages: new MemoryMessages(),
    media: new MemoryMedia(),
    calls: new MemoryCalls(),
    config: new MemoryConfig(),
    audit: new MemoryAudit(),
    typingSessions: new MemoryTypingSessions(),
    rateLimits: new MemoryRateLimits(),
    outbox: new MemoryOutbox(),
  };
}

export { resetStore, getStore, encodeCursor };

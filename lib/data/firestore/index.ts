import type {
  DocumentData,
  Firestore,
  Query,
  QueryDocumentSnapshot,
  Transaction,
} from 'firebase-admin/firestore';
import {
  ViewOnceState,
  type AdminUserRow,
  type AuditLogEntry,
  type Call,
  type Conversation,
  type ConversationParticipantState,
  type Cursor,
  type Media,
  type Message,
  type PublicUserSummary,
  type Timestamp,
  type TypingSession,
} from '@mt/types';
import { newId } from '@mt/utils';
import { getFirestoreDb } from '../../firebase/admin';
import {
  toAccessConfig,
  toAuditEntry,
  toCall,
  toConversation,
  toMedia,
  toMessage,
  toUserRecord,
  stripUndefined,
} from '../../firebase/serialize';
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
  RateLimitRepo,
  TypingSessionRepo,
  UserRecord,
  UserRepo,
  ViewOnceClaim,
} from '../types';

const COLLECTIONS = {
  users: 'users',
  conversations: 'conversations',
  messages: 'messages',
  userConversations: 'userConversations',
  calls: 'calls',
  media: 'media',
  typingSessions: 'typingSessions',
  auditLogs: 'adminAuditLogs',
  config: 'appConfig',
  rateLimits: 'rateLimits',
} as const;

function db(): Firestore {
  return getFirestoreDb();
}

function nowIso(): Timestamp {
  return new Date().toISOString();
}

/** Cursor = base64url of `${sortKey}|${id}` (ISO strings sort chronologically). */
function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { sortKey: string; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const index = decoded.lastIndexOf('|');
  if (index < 0) return null;
  return { sortKey: decoded.slice(0, index), id: decoded.slice(index + 1) };
}

interface PageOptions {
  limit: number;
  cursor?: string | null;
}

async function paginateQuery<T>(
  query: Query<DocumentData>,
  options: PageOptions,
  map: (snapshot: QueryDocumentSnapshot<DocumentData>) => T,
  sortField: string,
): Promise<Cursor<T>> {
  const cursor = decodeCursor(options.cursor);
  let scoped = query
    .orderBy(sortField, 'desc')
    .orderBy('__name__', 'desc')
    .limit(options.limit + 1);
  if (cursor) {
    scoped = scoped.startAfter(cursor.sortKey, cursor.id);
  }
  const snapshot = await scoped.get();
  const docs = snapshot.docs;
  const hasMore = docs.length > options.limit;
  const page = hasMore ? docs.slice(0, options.limit) : docs;
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    hasMore,
    nextCursor:
      hasMore && last ? encodeCursor(String(last.data()[sortField] ?? ''), last.id) : null,
  };
}

class FirestoreUsers implements UserRepo {
  private get col() {
    return db().collection(COLLECTIONS.users);
  }

  async create(record: UserRecord): Promise<UserRecord> {
    const emailLower = record.email.trim().toLowerCase();
    const searchKey = (record.name || record.email).trim().toLowerCase();
    await this.col.doc(record.id).set(
      stripUndefined({
        ...record,
        emailLower,
        searchKey,
      } as unknown as DocumentData),
    );
    return record;
  }

  async getById(userId: string): Promise<UserRecord | null> {
    const snapshot = await this.col.doc(userId).get();
    return snapshot.exists ? toUserRecord(snapshot.id, snapshot.data() ?? {}) : null;
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    const snapshot = await this.col.where('emailLower', '==', normalized).limit(1).get();
    const doc = snapshot.docs[0];
    return doc ? toUserRecord(doc.id, doc.data()) : null;
  }

  async update(userId: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const extra: Record<string, unknown> = {};
    if (patch.name) extra.searchKey = patch.name.trim().toLowerCase();
    if (patch.email) extra.emailLower = patch.email.trim().toLowerCase();
    await this.col
      .doc(userId)
      .set(stripUndefined({ ...patch, ...extra, updatedAt: nowIso() } as unknown as DocumentData), {
        merge: true,
      });
    return this.getById(userId);
  }

  async list(params: ListUsersParams): Promise<Cursor<AdminUserRow>> {
    let query: Query<DocumentData> = this.col;
    if (params.status) query = query.where('status', '==', params.status);
    if (params.q) {
      // Prefix search on the lowercase name; Firestore has no substring search,
      // so the admin panel documents this as "search by name prefix or email".
      const term = params.q.trim().toLowerCase();
      query = query.where('searchKey', '>=', term).where('searchKey', '<=', `${term}\uf8ff`);
    }
    const page = await paginateQuery(
      query,
      params,
      (doc) => toUserRecord(doc.id, doc.data()),
      'createdAt',
    );
    return {
      ...page,
      items: page.items.map(
        (user): AdminUserRow => ({ ...user, conversationCount: 0, messageCount: 0 }),
      ),
    };
  }

  async search(q: string, limit: number): Promise<PublicUserSummary[]> {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const snapshot = await this.col
      .where('status', '==', 'active')
      .where('searchKey', '>=', term)
      .where('searchKey', '<=', `${term}\uf8ff`)
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => {
      const user = toUserRecord(doc.id, doc.data());
      return {
        id: user.id,
        name: user.name,
        photoUrl: user.photoUrl,
        presence: 'offline' as const,
      };
    });
  }

  async countByStatus(): Promise<{ total: number; active: number; disabled: number }> {
    const [total, active, disabled] = await Promise.all([
      this.col.count().get(),
      this.col.where('status', '==', 'active').count().get(),
      this.col.where('status', '==', 'disabled').count().get(),
    ]);
    return {
      total: total.data().count,
      active: active.data().count,
      disabled: disabled.data().count,
    };
  }

  async touchLogin(userId: string, at: Timestamp): Promise<void> {
    await this.col.doc(userId).set({ lastLoginAt: at }, { merge: true });
  }
}

class FirestoreConversations implements ConversationRepo {
  private get col() {
    return db().collection(COLLECTIONS.conversations);
  }

  async findByParticipantKey(key: string): Promise<Conversation | null> {
    const snapshot = await this.col.where('participantKey', '==', key).limit(1).get();
    const doc = snapshot.docs[0];
    return doc ? toConversation(doc.id, doc.data()) : null;
  }

  async getById(conversationId: string): Promise<Conversation | null> {
    const snapshot = await this.col.doc(conversationId).get();
    return snapshot.exists ? toConversation(snapshot.id, snapshot.data() ?? {}) : null;
  }

  async create(conversation: Conversation): Promise<Conversation> {
    const batch = db().batch();
    batch.set(
      this.col.doc(conversation.id),
      stripUndefined(conversation as unknown as DocumentData),
    );
    for (const participantId of conversation.participantIds) {
      batch.set(
        db()
          .collection(COLLECTIONS.userConversations)
          .doc(participantId)
          .collection('items')
          .doc(conversation.id),
        {
          conversationId: conversation.id,
          lastActivityAt: conversation.lastActivityAt,
          hidden: false,
          createdAt: conversation.createdAt,
        },
      );
    }
    await batch.commit();
    return conversation;
  }

  async update(conversationId: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    await this.col
      .doc(conversationId)
      .set(stripUndefined(patch as unknown as DocumentData), { merge: true });
    const updated = await this.getById(conversationId);
    if (updated && patch.lastActivityAt) {
      const batch = db().batch();
      for (const participantId of updated.participantIds) {
        batch.set(
          db()
            .collection(COLLECTIONS.userConversations)
            .doc(participantId)
            .collection('items')
            .doc(conversationId),
          { lastActivityAt: patch.lastActivityAt },
          { merge: true },
        );
      }
      await batch.commit();
    }
    return updated;
  }

  async updateParticipant(
    conversationId: string,
    userId: string,
    patch: Partial<ConversationParticipantState>,
  ): Promise<Conversation | null> {
    await this.col
      .doc(conversationId)
      .set(
        { [`participants.${userId}`]: stripUndefined(patch as unknown as DocumentData) },
        { merge: true },
      );
    if (patch.hidden !== undefined) {
      await db()
        .collection(COLLECTIONS.userConversations)
        .doc(userId)
        .collection('items')
        .doc(conversationId)
        .set({ hidden: patch.hidden }, { merge: true });
    }
    return this.getById(conversationId);
  }

  /**
   * Listing goes through the `userConversations/{uid}/items` index collection so
   * a user with many conversations never reads the whole `conversations` set.
   */
  async list(params: ListConversationsParams): Promise<Cursor<Conversation>> {
    const items = db()
      .collection(COLLECTIONS.userConversations)
      .doc(params.userId)
      .collection('items');
    const query: Query<DocumentData> = params.includeHidden
      ? items
      : items.where('hidden', '==', false);
    const cursor = decodeCursor(params.cursor);
    let scoped = query.orderBy('lastActivityAt', 'desc').limit(params.limit + 1);
    if (cursor) scoped = scoped.startAfter(cursor.sortKey, cursor.id);
    const snapshot = await scoped.get();
    const hasMore = snapshot.docs.length > params.limit;
    const page = hasMore ? snapshot.docs.slice(0, params.limit) : snapshot.docs;
    const conversations = await Promise.all(page.map((doc) => this.getById(doc.id)));
    const last = page[page.length - 1];
    return {
      items: conversations.filter((conversation): conversation is Conversation =>
        Boolean(conversation),
      ),
      hasMore,
      nextCursor:
        hasMore && last ? encodeCursor(String(last.data()['lastActivityAt'] ?? ''), last.id) : null,
    };
  }

  async countAll(): Promise<number> {
    const snapshot = await this.col.count().get();
    return snapshot.data().count;
  }
}

class FirestoreMessages implements MessageRepo {
  private messagesOf(conversationId: string) {
    return db()
      .collection(COLLECTIONS.conversations)
      .doc(conversationId)
      .collection(COLLECTIONS.messages);
  }

  async create(message: Message): Promise<Message> {
    // `messageId` is duplicated as a field so administrators (and the edit/delete
    // routes, which only receive an id) can look a message up across the
    // `conversations/*\/messages` subcollections with a collection group query.
    await this.messagesOf(message.conversationId)
      .doc(message.id)
      .set(stripUndefined({ ...message, messageId: message.id } as unknown as DocumentData));
    return message;
  }

  async getById(messageId: string): Promise<Message | null> {
    const found = await db()
      .collectionGroup(COLLECTIONS.messages)
      .where('messageId', '==', messageId)
      .limit(1)
      .get();
    const doc = found.docs[0];
    return doc ? toMessage(doc.id, doc.data()) : null;
  }

  async findByClientMessageId(params: {
    conversationId: string;
    senderId: string;
    clientMessageId: string;
  }): Promise<Message | null> {
    const snapshot = await this.messagesOf(params.conversationId)
      .where('senderId', '==', params.senderId)
      .where('clientMessageId', '==', params.clientMessageId)
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    return doc ? toMessage(doc.id, doc.data()) : null;
  }

  async list(params: ListMessagesParams): Promise<Cursor<Message>> {
    let query: Query<DocumentData> = this.messagesOf(params.conversationId);
    if (!params.includeDeleted) query = query.where('deleted', '==', false);
    if (params.before) query = query.where('createdAt', '<', params.before);
    if (params.after) query = query.where('createdAt', '>', params.after);
    if (params.q) {
      // Firestore cannot do substring search; the API layer filters the page it
      // already fetched and documents the limitation.
      void params.q;
    }
    if (params.after) {
      const snapshot = await query.orderBy('createdAt', 'asc').limit(params.limit).get();
      return {
        items: snapshot.docs.map((doc) => toMessage(doc.id, doc.data())),
        nextCursor: null,
        hasMore: false,
      };
    }
    return paginateQuery(query, params, (doc) => toMessage(doc.id, doc.data()), 'createdAt');
  }

  async update(messageId: string, patch: Partial<Message>): Promise<Message | null> {
    const existing = await this.getById(messageId);
    if (!existing) return null;
    await this.messagesOf(existing.conversationId)
      .doc(messageId)
      .set(stripUndefined({ ...patch, updatedAt: nowIso() } as unknown as DocumentData), {
        merge: true,
      });
    return this.getById(messageId);
  }

  async countForConversation(conversationId: string): Promise<number> {
    const snapshot = await this.messagesOf(conversationId).count().get();
    return snapshot.data().count;
  }

  async countAll(): Promise<{ total: number; deleted: number; last24h: number }> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [total, deleted, last24h] = await Promise.all([
      db().collectionGroup(COLLECTIONS.messages).count().get(),
      db().collectionGroup(COLLECTIONS.messages).where('deleted', '==', true).count().get(),
      db().collectionGroup(COLLECTIONS.messages).where('createdAt', '>=', cutoff).count().get(),
    ]);
    return {
      total: total.data().count,
      deleted: deleted.data().count,
      last24h: last24h.data().count,
    };
  }

  async listForUser(userId: string, limit: number): Promise<Cursor<Message>> {
    return paginateQuery(
      db().collectionGroup(COLLECTIONS.messages).where('senderId', '==', userId),
      { limit },
      (doc) => toMessage(doc.id, doc.data()),
      'createdAt',
    );
  }

  async listRecent(limit: number): Promise<Message[]> {
    const snapshot = await db()
      .collectionGroup(COLLECTIONS.messages)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => toMessage(doc.id, doc.data()));
  }
}

class FirestoreMedia implements MediaRepo {
  private get col() {
    return db().collection(COLLECTIONS.media);
  }

  async create(media: Media): Promise<Media> {
    await this.col.doc(media.id).set(stripUndefined(media as unknown as DocumentData));
    return media;
  }

  async getById(mediaId: string): Promise<Media | null> {
    const snapshot = await this.col.doc(mediaId).get();
    return snapshot.exists ? toMedia(snapshot.id, snapshot.data() ?? {}) : null;
  }

  async update(mediaId: string, patch: Partial<Media>): Promise<Media | null> {
    await this.col
      .doc(mediaId)
      .set(stripUndefined({ ...patch, updatedAt: nowIso() } as unknown as DocumentData), {
        merge: true,
      });
    return this.getById(mediaId);
  }

  async list(params: ListMediaParams): Promise<Cursor<Media>> {
    let query: Query<DocumentData> = this.col;
    if (!params.includeDeleted) query = query.where('deleted', '==', false);
    if (params.kind) query = query.where('kind', '==', params.kind);
    if (params.viewOnceOnly) query = query.where('viewOnce', '==', true);
    return paginateQuery(query, params, (doc) => toMedia(doc.id, doc.data()), 'createdAt');
  }

  async listForConversation(conversationId: string): Promise<Media[]> {
    const snapshot = await this.col.where('conversationId', '==', conversationId).get();
    return snapshot.docs.map((doc) => toMedia(doc.id, doc.data()));
  }

  /**
   * Atomic claim: the whole read-check-write happens inside a Firestore
   * transaction, so two simultaneous "open" requests can never both succeed.
   */
  async claimViewOnce(mediaId: string, viewerId: string): Promise<ViewOnceClaim> {
    const ref = this.col.doc(mediaId);
    return db().runTransaction(async (transaction: Transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return { media: null, claimed: false };
      const media = toMedia(snapshot.id, snapshot.data() ?? {});
      const claimable =
        !media.deleted &&
        media.ownerId !== viewerId &&
        (media.viewOnceState === ViewOnceState.Delivered ||
          media.viewOnceState === ViewOnceState.Viewable);
      if (!claimable) return { media, claimed: false };
      const updated: Media = {
        ...media,
        viewOnceState: ViewOnceState.Viewing,
        updatedAt: nowIso(),
      };
      transaction.set(
        ref,
        { viewOnceState: ViewOnceState.Viewing, updatedAt: nowIso() },
        { merge: true },
      );
      return { media: updated, claimed: true };
    });
  }

  async markViewed(mediaId: string, viewerId: string): Promise<Media | null> {
    const now = nowIso();
    await this.col
      .doc(mediaId)
      .set(
        { viewOnceState: ViewOnceState.Viewed, viewedAt: now, viewedBy: viewerId, updatedAt: now },
        { merge: true },
      );
    return this.getById(mediaId);
  }

  async countAll(): Promise<{ total: number; viewOnce: number; deleted: number }> {
    const [total, viewOnce, deleted] = await Promise.all([
      this.col.count().get(),
      this.col.where('viewOnce', '==', true).count().get(),
      this.col.where('deleted', '==', true).count().get(),
    ]);
    return {
      total: total.data().count,
      viewOnce: viewOnce.data().count,
      deleted: deleted.data().count,
    };
  }
}

class FirestoreCalls implements CallRepo {
  private get col() {
    return db().collection(COLLECTIONS.calls);
  }

  async create(call: Call): Promise<Call> {
    await this.col.doc(call.id).set(stripUndefined(call as unknown as DocumentData));
    return call;
  }

  async getById(callId: string): Promise<Call | null> {
    const snapshot = await this.col.doc(callId).get();
    return snapshot.exists ? toCall(snapshot.id, snapshot.data() ?? {}) : null;
  }

  async update(callId: string, patch: Partial<Call>): Promise<Call | null> {
    await this.col
      .doc(callId)
      .set(stripUndefined({ ...patch, updatedAt: nowIso() } as unknown as DocumentData), {
        merge: true,
      });
    return this.getById(callId);
  }

  async list(params: ListCallsParams): Promise<Cursor<Call>> {
    let query: Query<DocumentData> = this.col;
    if (params.conversationId) query = query.where('conversationId', '==', params.conversationId);
    if (params.userId) {
      query = query.where('initiatorId', '==', params.userId);
      // Firestore cannot OR across fields in a single query; the recipient side
      // is fetched separately by the service layer when needed.
    }
    return paginateQuery(query, params, (doc) => toCall(doc.id, doc.data()), 'createdAt');
  }

  async findActiveForConversation(conversationId: string): Promise<Call | null> {
    for (const status of ['ringing', 'accepted', 'active']) {
      const snapshot = await this.col
        .where('conversationId', '==', conversationId)
        .where('status', '==', status)
        .limit(1)
        .get();
      const doc = snapshot.docs[0];
      if (doc) return toCall(doc.id, doc.data());
    }
    return null;
  }

  async findRingingForUser(userId: string): Promise<Call | null> {
    const snapshot = await this.col
      .where('recipientId', '==', userId)
      .where('status', '==', 'ringing')
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    return doc ? toCall(doc.id, doc.data()) : null;
  }

  async countAll(): Promise<number> {
    const snapshot = await this.col.count().get();
    return snapshot.data().count;
  }
}

class FirestoreConfig implements ConfigRepo {
  private get ref() {
    return db().collection(COLLECTIONS.config).doc('access');
  }

  async getAccessConfig(): Promise<AccessConfigRecord> {
    const snapshot = await this.ref.get();
    if (!snapshot.exists) {
      const created: AccessConfigRecord = {
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
      await this.ref.set(created);
      return created;
    }
    return toAccessConfig(snapshot.data() ?? {});
  }

  async setAccessConfig(patch: Partial<AccessConfigRecord>): Promise<AccessConfigRecord> {
    await this.ref.set(stripUndefined(patch as unknown as DocumentData), { merge: true });
    return this.getAccessConfig();
  }

  async incrementUnlockCount(): Promise<AccessConfigRecord> {
    const { FieldValue } = await import('firebase-admin/firestore');
    await this.ref.set({ unlockCount: FieldValue.increment(1) }, { merge: true });
    return this.getAccessConfig();
  }
}

class FirestoreAudit implements AuditRepo {
  private get col() {
    return db().collection(COLLECTIONS.auditLogs);
  }

  async append(entry: AuditLogEntry): Promise<AuditLogEntry> {
    await this.col.doc(entry.id).set(stripUndefined(entry as unknown as DocumentData));
    return entry;
  }

  async list(params: ListAuditParams): Promise<Cursor<AuditLogEntry>> {
    let query: Query<DocumentData> = this.col;
    if (params.action) query = query.where('action', '==', params.action);
    if (params.actorUid) query = query.where('actorUid', '==', params.actorUid);
    return paginateQuery(query, params, (doc) => toAuditEntry(doc.id, doc.data()), 'createdAt');
  }
}

class FirestoreTypingSessions implements TypingSessionRepo {
  private get col() {
    return db().collection(COLLECTIONS.typingSessions);
  }

  async create(session: TypingSession): Promise<TypingSession> {
    await this.col.doc(session.id).set(stripUndefined(session as unknown as DocumentData));
    return session;
  }

  async countAll(): Promise<number> {
    const snapshot = await this.col.count().get();
    return snapshot.data().count;
  }

  async listRecent(limit: number): Promise<TypingSession[]> {
    const snapshot = await this.col.orderBy('createdAt', 'desc').limit(limit).get();
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      userId: (doc.data()['userId'] as string | null) ?? null,
      result: doc.data()['result'] as TypingSession['result'],
      attempts: (doc.data()['attempts'] as TypingSession['attempts']) ?? [],
      createdAt: String(doc.data()['createdAt']),
      updatedAt: String(doc.data()['updatedAt']),
    }));
  }
}

/**
 * Firestore backed rate limiting. Best effort by nature (a burst across two
 * instances can slip through); it exists to blunt credential stuffing and
 * brute force attempts, not to be a precise quota system.
 */
class FirestoreRateLimits implements RateLimitRepo {
  async consume(key: string, options: { limit: number; windowMs: number }) {
    const ref = db().collection(COLLECTIONS.rateLimits).doc(safeDocId(key));
    const now = Date.now();
    return db().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data();
      const resetAt = Number(data?.['resetAt'] ?? 0);
      const fresh = !snapshot.exists || resetAt <= now;
      const count = fresh ? 1 : Number(data?.['count'] ?? 0) + 1;
      const nextResetAt = fresh ? now + options.windowMs : resetAt;
      transaction.set(ref, { count, resetAt: nextResetAt });
      return {
        allowed: count <= options.limit,
        remaining: Math.max(0, options.limit - count),
        resetAt: nextResetAt,
        retryAfterSeconds: Math.max(0, Math.ceil((nextResetAt - now) / 1000)),
      };
    });
  }
}

function safeDocId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

export function createFirestoreDataProvider(): DataProvider {
  return {
    name: 'firestore',
    users: new FirestoreUsers(),
    conversations: new FirestoreConversations(),
    messages: new FirestoreMessages(),
    media: new FirestoreMedia(),
    calls: new FirestoreCalls(),
    config: new FirestoreConfig(),
    audit: new FirestoreAudit(),
    typingSessions: new FirestoreTypingSessions(),
    rateLimits: new FirestoreRateLimits(),
  };
}

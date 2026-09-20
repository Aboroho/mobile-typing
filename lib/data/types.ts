import type {
  AccountStatus,
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
  UserProfile,
} from '@mt/types';

/**
 * Persistence boundary.
 *
 * Everything above this line (services, API routes) talks to these interfaces
 * using plain objects and ISO timestamps. `memory` powers local development and
 * the test suite, `prisma` (PostgreSQL) is the production implementation. Swapping the
 * backend is therefore a configuration change, not a refactor — which is also
 * what allows a future React Native client to share this layer through the API.
 */

/**
 * A stored profile.
 *
 * `id` is the application user id (`u_…`). The Argon2 password hash is stored
 * alongside the record by the provider but is never exposed through this
 * interface (see `createUserWithHash` in `lib/services/auth-service.ts`).
 */
export interface UserRecord extends UserProfile {
  /** Why an administrator disabled the account, when they gave a reason. */
  disabledReason: string | null;
}

export interface ListUsersParams {
  limit: number;
  cursor?: string | null;
  q?: string;
  status?: AccountStatus;
}

export interface UserRepo {
  create(record: UserRecord): Promise<UserRecord>;
  getById(userId: string): Promise<UserRecord | null>;
  getByEmail(email: string): Promise<UserRecord | null>;
  update(userId: string, patch: Partial<UserRecord>): Promise<UserRecord | null>;
  list(params: ListUsersParams): Promise<Cursor<AdminUserRow>>;
  search(q: string, limit: number): Promise<PublicUserSummary[]>;
  countByStatus(): Promise<{ total: number; active: number; disabled: number }>;
  touchLogin(userId: string, at: Timestamp): Promise<void>;
}

export interface ListConversationsParams {
  userId: string;
  limit: number;
  cursor?: string | null;
  includeHidden?: boolean;
}

export interface ConversationRepo {
  findByParticipantKey(key: string): Promise<Conversation | null>;
  getById(conversationId: string): Promise<Conversation | null>;
  create(conversation: Conversation): Promise<Conversation>;
  update(conversationId: string, patch: Partial<Conversation>): Promise<Conversation | null>;
  updateParticipant(
    conversationId: string,
    userId: string,
    patch: Partial<ConversationParticipantState>,
  ): Promise<Conversation | null>;
  list(params: ListConversationsParams): Promise<Cursor<Conversation>>;
  countAll(): Promise<number>;
}

export interface ListMessagesParams {
  conversationId: string;
  limit: number;
  cursor?: string | null;
  /** Strictly older than this timestamp (paginate backwards in time). */
  before?: Timestamp;
  /** Strictly newer than this timestamp (live tail). */
  after?: Timestamp;
  q?: string;
  /** Admin only: include soft deleted rows with their hidden content. */
  includeDeleted?: boolean;
}

export interface MessageRepo {
  create(message: Message): Promise<Message>;
  getById(messageId: string): Promise<Message | null>;
  findByClientMessageId(params: {
    conversationId: string;
    senderId: string;
    clientMessageId: string;
  }): Promise<Message | null>;
  list(params: ListMessagesParams): Promise<Cursor<Message>>;
  update(messageId: string, patch: Partial<Message>): Promise<Message | null>;
  countForConversation(conversationId: string): Promise<number>;
  countAll(): Promise<{ total: number; deleted: number; last24h: number }>;
  listForUser(userId: string, limit: number): Promise<Cursor<Message>>;
  listRecent(limit: number): Promise<Message[]>;
}

export interface ListMediaParams {
  limit: number;
  cursor?: string | null;
  kind?: 'image' | 'voice';
  includeDeleted?: boolean;
  viewOnceOnly?: boolean;
}

/** Result of the atomic view-once claim: `null` means the caller lost the race. */
export interface ViewOnceClaim {
  /** The record as it stands after the attempt, or null when it does not exist. */
  media: Media | null;
  claimed: boolean;
}

export interface MediaRepo {
  create(media: Media): Promise<Media>;
  getById(mediaId: string): Promise<Media | null>;
  update(mediaId: string, patch: Partial<Media>): Promise<Media | null>;
  list(params: ListMediaParams): Promise<Cursor<Media>>;
  listForConversation(conversationId: string): Promise<Media[]>;
  /**
   * Atomically moves a view-once item into the `viewing` state. Returns
   * `claimed: false` when another request already consumed it.
   */
  claimViewOnce(mediaId: string, viewerId: string): Promise<ViewOnceClaim>;
  markViewed(mediaId: string, viewerId: string): Promise<Media | null>;
  countAll(): Promise<{ total: number; viewOnce: number; deleted: number }>;
}

export interface ListCallsParams {
  limit: number;
  cursor?: string | null;
  conversationId?: string;
  /** Restrict to calls this user participates in. */
  userId?: string;
}

export interface CallRepo {
  create(call: Call): Promise<Call>;
  getById(callId: string): Promise<Call | null>;
  update(callId: string, patch: Partial<Call>): Promise<Call | null>;
  list(params: ListCallsParams): Promise<Cursor<Call>>;
  findActiveForConversation(conversationId: string): Promise<Call | null>;
  findRingingForUser(userId: string): Promise<Call | null>;
  countAll(): Promise<number>;
}

export interface AccessConfigRecord {
  /** Plaintext code — required because the challenge endpoint hands it to the browser. */
  code: string;
  /** Salted digest, used for integrity checks and audit. */
  digest: string;
  salt: string;
  maxLength: number;
  caseSensitive: boolean;
  epoch: number;
  unlockCount: number;
  updatedAt: Timestamp | null;
  updatedBy: string | null;
  createdAt: Timestamp;
}

export interface ConfigRepo {
  getAccessConfig(): Promise<AccessConfigRecord>;
  setAccessConfig(patch: Partial<AccessConfigRecord>): Promise<AccessConfigRecord>;
  incrementUnlockCount(): Promise<AccessConfigRecord>;
}

export interface ListAuditParams {
  limit: number;
  cursor?: string | null;
  action?: string;
  actorUid?: string;
}

export interface AuditRepo {
  append(entry: AuditLogEntry): Promise<AuditLogEntry>;
  list(params: ListAuditParams): Promise<Cursor<AuditLogEntry>>;
}

export interface TypingSessionRepo {
  create(session: TypingSession): Promise<TypingSession>;
  countAll(): Promise<number>;
  listRecent(limit: number): Promise<TypingSession[]>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimitRepo {
  consume(key: string, options: { limit: number; windowMs: number }): Promise<RateLimitResult>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionUserJoin {
  id: string;
  email: string;
  name: string | null;
  disabled: boolean;
}

export interface SessionRepo {
  create(input: {
    id: string;
    userId: string;
    tokenHash: string;
    userAgent: string | null;
    ip: string | null;
    createdAt: Date;
    lastActiveAt: Date;
    expiresAt: Date;
  }): Promise<SessionRecord>;
  findByTokenHash(tokenHash: string): Promise<(SessionRecord & { user: SessionUserJoin }) | null>;
  touch(id: string, lastActiveAt: Date): Promise<void>;
  revokeByTokenHash(tokenHash: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<number>;
}

export interface OutboxEventRecord {
  id: string;
  userId: string;
  topic: string;
  type: string;
  payload: unknown;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface OutboxRepo {
  enqueue(input: { id: string; userId: string; topic: string; type: string; payload: unknown; createdAt: Date }): Promise<OutboxEventRecord>;
  listForUser(userId: string, afterId: string | null, limit: number): Promise<OutboxEventRecord[]>;
  markDelivered(ids: string[]): Promise<void>;
  claimPending(limit: number): Promise<OutboxEventRecord[]>;
}

export interface DataProvider {
  readonly name: 'memory' | 'prisma';
  users: UserRepo;
  sessions: SessionRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  media: MediaRepo;
  calls: CallRepo;
  config: ConfigRepo;
  audit: AuditRepo;
  typingSessions: TypingSessionRepo;
  rateLimits: RateLimitRepo;
  outbox: OutboxRepo;
}

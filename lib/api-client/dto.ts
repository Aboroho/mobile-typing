import type {
  AccessChallenge,
  AccessChallengeStatus,
  AccountStatus,
  AdminUserRow,
  AuditLogEntry,
  Call,
  CallView,
  ConversationView,
  Cursor,
  Dashboard,
  IceServer,
  MediaForAdmin,
  MessageForAdmin,
  MessageForUser,
  Presence,
  PublicUserSummary,
  SecretCodeStatus,
  Timestamp,
  TypingSession,
  UserProfile,
  UserSearchResult,
} from '@mt/types';

/** Authenticated session as returned by the API. Never contains secrets. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  photoUrl: string | null;
  status: AccountStatus;
  isAdmin: boolean;
  createdAt: Timestamp;
  lastLoginAt: Timestamp | null;
}

export interface AuthResult {
  user: SessionUser;
  /** Firebase ID token, or a dev session token. The client stores/attaches it. */
  token: string | null;
  /** True when a session cookie was set instead of a bearer token. */
  cookieSession: boolean;
  /** Access session granted as part of registration/login. */
  accessGranted: boolean;
}

export interface ReauthenticateResult {
  user: SessionUser;
  accessGranted: boolean;
}

export interface UnlockResult {
  unlocked: boolean;
  epoch: number;
  expiresAt: Timestamp;
  /** Present when the browser is already authenticated. */
  user: SessionUser | null;
}

export type ChallengeResponse = AccessChallenge;

/**
 * `GET /api/v1/access/status`.
 *
 * `unlocked` reflects the access session cookie this browser presents, so a
 * reload can restore the unlocked UI without re-typing the secret code. It is
 * advisory only: every protected route re-validates the cookie server side.
 */
export interface AccessStatusResponse {
  status: AccessChallengeStatus;
  unlocked: boolean;
  session: { epoch: number; expiresAt: string } | null;
}

export interface ConversationListResponse {
  items: ConversationView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ConversationDetailResponse {
  conversation: ConversationView;
  iceServers: IceServer[];
  activeCall: CallView | null;
}

export interface MessageListResponse {
  items: MessageForUser[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SendMessageResponse {
  message: MessageForUser;
  conversation: ConversationView;
}

export interface UploadIntentResponse {
  mediaId: string;
  storagePath: string;
  uploadUrl: string;
  /** Route relative URL the client POSTs the bytes to. */
  maxBytes: number;
  mimeType: string;
}

export interface UploadResult {
  mediaId: string;
  sizeBytes: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface MediaViewResult {
  mediaId: string;
  contentUrl: string;
  /** Seconds the client may keep the URL in memory. */
  ttlSeconds: number;
  mimeType: string;
}

export interface CallCreateResponse {
  call: Call;
  iceServers: IceServer[];
}

export interface CallHistoryResponse {
  items: CallView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface IceServerResponse {
  iceServers: IceServer[];
  hasTurn: boolean;
}

export interface TypingSessionResponse {
  session: TypingSession;
}

export interface AdminUserListResponse {
  items: AdminUserRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AdminConversationResponse {
  conversationId: string | null;
  exists: boolean;
  participants: PublicUserSummary[];
  messageCount: number;
}

export interface AdminMessageListResponse {
  items: MessageForAdmin[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AdminMediaListResponse {
  items: MediaForAdmin[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AdminAuditResponse {
  items: AuditLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PresenceResponse {
  userId: string;
  presence: Presence;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  dataProvider: string;
  authProvider: string;
  storageProvider: string;
  time: Timestamp;
  /** True when an administrator has configured a secret code. */
  access: AccessChallengeStatus;
}

export type {
  Cursor,
  Dashboard,
  SecretCodeStatus,
  UserProfile,
  UserSearchResult,
  PublicUserSummary,
};

import type { EntityTimestamps, Timestamp } from './common';
import type { AccountStatus, UserProfile } from './user';

export interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  disabledUsers: number;
  conversations: number;
  messages: number;
  deletedMessages: number;
  media: number;
  viewOnceMedia: number;
  deletedMedia: number;
  calls: number;
  typingSessions: number;
  last24hMessages: number;
}

export interface RecentActivity {
  id: string;
  kind: 'message' | 'call' | 'user' | 'audit';
  title: string;
  description: string;
  createdAt: Timestamp;
}

export interface Dashboard {
  stats: DashboardStats;
  recent: RecentActivity[];
  generatedAt: Timestamp;
}

/** Secret-code status. The code itself is never returned to the panel. */
export interface SecretCodeStatus {
  configured: boolean;
  length: number | null;
  epoch: number;
  caseSensitive: boolean;
  maxLength: number;
  updatedAt: Timestamp | null;
  updatedBy: string | null;
  /** Count of successful unlocks for the current epoch. */
  unlockCount: number;
}

export const AuditAction = {
  SecretCodeChanged: 'secret_code.changed',
  SecretCodeRead: 'secret_code.read',
  ConversationInspected: 'admin.conversation.inspected',
  MessageDeletedContentRead: 'admin.message.deleted_read',
  MediaInspected: 'admin.media.inspected',
  MediaContentDownloaded: 'admin.media.downloaded',
  UserStatusChanged: 'admin.user.status_changed',
  AdminLogin: 'admin.login',
  ConfigChanged: 'admin.config.changed',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditLogEntry extends EntityTimestamps {
  id: string;
  actorUid: string;
  actorEmail: string | null;
  action: AuditAction | string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  ipAddress: string | null;
}

export interface AdminUserRow extends UserProfile {
  conversationCount: number;
  messageCount: number;
}

export interface UserStatusUpdate {
  userId: string;
  status: AccountStatus;
  reason: string | null;
}

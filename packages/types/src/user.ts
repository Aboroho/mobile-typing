import type { EntityTimestamps, Timestamp } from './common';

export const AccountStatus = {
  Active: 'active',
  Disabled: 'disabled',
  Deleted: 'deleted',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const UserRole = {
  User: 'user',
  Admin: 'admin',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Full user record. Never sent to other users. */
export interface UserProfile extends EntityTimestamps {
  id: string;
  name: string;
  email: string;
  photoUrl: string | null;
  status: AccountStatus;
  lastLoginAt: Timestamp | null;
  /** True when this uid matches the server side `ADMIN_UID`. Derived, not stored. */
  isAdmin: boolean;
}

/** What other participants are allowed to see. */
export interface PublicUserSummary {
  id: string;
  name: string;
  photoUrl: string | null;
  presence: PresenceState;
}

export const PresenceState = {
  Online: 'online',
  Offline: 'offline',
} as const;
export type PresenceState = (typeof PresenceState)[keyof typeof PresenceState];

export interface Presence {
  state: PresenceState;
  lastSeenAt: Timestamp | null;
}

export interface UserSearchResult extends PublicUserSummary {
  /** True when a conversation already exists with this user. */
  hasConversation: boolean;
  conversationId: string | null;
}

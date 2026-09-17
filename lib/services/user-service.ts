import { AppError } from '@mt/domain';
import { sanitizeName } from '@mt/domain';
import type { Presence, PublicUserSummary, UserSearchResult } from '@mt/types';
import { nowIso } from '@mt/utils';
import type { SessionUser } from '@mt/api-client';
import { getData, type UserRecord } from '../data';
import { isAdminUser } from '../auth/session';
import { conversationKeyFor } from '@mt/domain';

export function toSessionUser(record: UserRecord): SessionUser {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    photoUrl: record.photoUrl,
    status: record.status,
    isAdmin: isAdminUser(record),
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt,
  };
}

export function toPublicSummary(record: UserRecord, presence: Presence = { state: 'offline', lastSeenAt: null }): PublicUserSummary {
  return {
    id: record.id,
    name: record.name,
    photoUrl: record.photoUrl,
    presence: presence.state,
  };
}

/**
 * User search. Results are limited to active accounts and never expose emails
 * beyond what is needed to disambiguate two people with the same name.
 */
export async function searchUsers(input: { actorId: string; q: string; limit: number }): Promise<UserSearchResult[]> {
  const data = await getData();
  const matches = await data.users.search(input.q, input.limit + 5);
  const results: UserSearchResult[] = [];
  for (const match of matches) {
    if (match.id === input.actorId) continue;
    const key = conversationKeyFor(input.actorId, match.id);
    const existing = await data.conversations.findByParticipantKey(key);
    results.push({
      ...match,
      hasConversation: Boolean(existing),
      conversationId: existing?.id ?? null,
    });
    if (results.length >= input.limit) break;
  }
  return results;
}

export async function getUserProfile(userId: string) {
  const data = await getData();
  const record = await data.users.getById(userId);
  if (!record) throw AppError.notFound('user not found');
  return toSessionUser(record);
}

export async function updateProfile(input: {
  actorId: string;
  name?: string;
  photoUrl?: string | null;
}): Promise<SessionUser> {
  const data = await getData();
  const patch: Partial<UserRecord> = { updatedAt: nowIso() };
  if (input.name !== undefined) patch.name = sanitizeName(input.name);
  if (input.photoUrl !== undefined) patch.photoUrl = input.photoUrl;
  const updated = await data.users.update(input.actorId, patch);
  if (!updated) throw AppError.notFound('user not found');
  return toSessionUser(updated);
}

/**
 * Presence is advisory: it is used for the "online" dot only and is never
 * authoritative, because a browser cannot reliably report leaving.
 */
export async function setPresence(userId: string, state: Presence['state']): Promise<Presence> {
  const data = await getData();
  const presence: Presence = { state, lastSeenAt: state === 'offline' ? nowIso() : null };
  await data.users.update(userId, {
    lastLoginAt: state === 'online' ? nowIso() : undefined,
  });
  return presence;
}

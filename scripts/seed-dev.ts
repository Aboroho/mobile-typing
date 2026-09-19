#!/usr/bin/env tsx
/**
 * Seed the dev environment with two demo users and a conversation between them.
 *
 *   npm run seed
 */
import { getData } from '../lib/data';
import { register as registerService } from '../lib/services/auth-service';
import { newId } from '../lib/utils';

const PASSWORD = 'CorrectHorse1!';

async function ensureUser(name: string, email: string) {
  const data = await getData();
  const existing = await data.users.getByEmail(email);
  if (existing) {
    console.log(`user ${email} already exists (${existing.id})`);
    return existing;
  }
  // Use the real register flow so password hashing/session plumbing is exercised.
  // We pass a fake Request with no cookies to avoid side effects.
  const fakeReq = new Request('http://localhost/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const outcome = await registerService({ name, email, password: PASSWORD, request: fakeReq });
  console.log(`created user ${email} (${outcome.user.id}) / password: ${PASSWORD}`);
  return outcome.user;
}

async function main() {
  if ((process.env.NODE_ENV ?? 'development') === 'production') {
    console.error('refusing to seed in NODE_ENV=production');
    process.exit(1);
  }

  const alice = await ensureUser('Alice', 'alice@example.com');
  const bob = await ensureUser('Bob', 'bob@example.com');
  const data = await getData();

  const key = [alice.id, bob.id].sort().join(':');
  const existing = await data.conversations.findByParticipantKey(key);
  if (existing) {
    console.log(`conversation already exists (${existing.id})`);
    return;
  }
  const now = new Date().toISOString();
  const cid = newId('c');
  await data.conversations.create({
    id: cid,
    participantIds: [alice.id, bob.id],
    participantKey: key,
    lastMessage: null,
    lastActivityAt: now,
    lastMessageAt: null,
    participants: {
      [alice.id]: { lastReadAt: null, lastReadMessageAt: null, unreadCount: 0, hidden: false, hiddenAt: null, blockedUserIds: [] },
      [bob.id]: { lastReadAt: null, lastReadMessageAt: null, unreadCount: 0, hidden: false, hiddenAt: null, blockedUserIds: [] },
    },
    createdAt: now, updatedAt: now,
  });
  console.log(`created conversation ${cid}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

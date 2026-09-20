# Database schema (PostgreSQL via Prisma)

The authoritative schema is [`prisma/schema.prisma`](../prisma/schema.prisma).
This document explains the tables, the conventions, and what **isn't** stored.

- `DATA_PROVIDER=prisma` reads/writes these tables through
  `lib/data/prisma/index.ts`; `DATA_PROVIDER=memory` mirrors the same shapes
  in process-local Maps. Services only ever see the provider interface.
- All primary keys are `cuid()` strings, except the singleton
  `SecretCodeConfiguration` (integer id `1`).
- Statuses are plain strings validated in the service layer
  (`active | disabled`, `ringing | accepted | …`) — not Postgres enums — so
  adding a state never needs a migration.
- Pagination is keyset-based (`before` / `after` / `cursor` over creation
  order), so there are no `OFFSET` cliffs.
- Deletion is **soft** everywhere it matters (`deleted`, `deletedAt`): rows
  survive for administrators.

```bash
npx prisma migrate dev    # local: create + apply a migration
npm run prisma:generate   # regenerate the client
npm run prisma:deploy     # production: apply pending migrations (migrate deploy)
```

## Users & sessions

**User** — one row per account. `email` and `emailNormalized` are both unique;
lookups go through the normalised column. `passwordHash` is an Argon2id hash;
it is written separately from the profile (`createUserWithHash`) because
`UserRecord` — the shape services see — deliberately has no password field.
`status` is `active | disabled` with an optional `disabledReason`.
`lastLoginAt` is touched on every login.

**UserSession** — one row per issued session. `tokenHash` (unique) is the
SHA-256 of the opaque token handed to the client, so a database leak does not
yield usable sessions. `userAgent`/`ip` are recorded for forensics;
`expiresAt` comes from `SESSION_DURATION_HOURS`; `revokedAt` is set on logout
(admin inspection / rotation can revoke rows too). Indexes on `userId` and
`expiresAt`.

## Conversations

**Conversation** — strictly 1:1. `participantKey` is the unique sorted
`"a|b"` pair key, so the same two users always resolve to the same
conversation; `participantIds` holds exactly the two user ids.
`lastMessageText`/`lastMessageAt` denormalise the list preview;
`lastActivityAt` drives list ordering (indexed).

**ConversationMember** — one row per (conversation, user), unique on the pair.
Carries the per-user view state: `lastReadAt`, `lastReadMessageAt`,
`unreadCount`, `hidden` (+`hiddenAt`), and `blockedUserIds`. Indexed on
`userId` for "my conversations" queries.

## Messages

**Message** — `kind` is `text | image | voice | system`. `clientMessageId` is
unique per (conversation, sender) so client retries are idempotent. Rich detail
(replies, dimensions, durations, call summaries) lives in the `metadata` JSON
column. `edited` flags author edits (history in `MessageEdit`); `deleted` /
`deletedAt` / `deletedBy` implement soft delete; `expiresAt` is reserved for
future ephemeral messages. Indexes: `(conversationId, createdAt)`,
`(senderId, createdAt)`, `(conversationId, deleted)`.

**MessageEdit** — full previous/new text per edit, with the actor. Only the
author can edit, within a two-minute window enforced by the service.

**MessageReceipt** — one row per (message, user, `delivered | read`) with
timestamps. Receipts from the author are ignored upstream.

## Media

**MediaObject** — metadata for one upload; the bytes live in the configured
storage provider under the random, non-guessable `objectKey` (unique).
`conversationId` is null while the upload is still a draft. `provider` records
which store holds the bytes (`s3 | local | memory`). `uploadState` is
`pending | uploading | ready | failed`. View-once lifecycle:
`viewOnce` + `viewOnceState` (`sent | delivered | viewable | viewing | viewed |
expired`), `viewedAt`, `viewedBy`. Soft delete via `deleted`/`deletedAt`;
`metadata` JSON carries width/height/duration/deletedBy. Indexes on
`(conversationId, createdAt)`, `(ownerId, createdAt)`,
`(viewOnce, viewOnceState)` and `deleted`.

**MessageMedia** — join table linking messages to media, unique on
(message, media).

## Realtime outbox

**OutboxEvent** — one row per recipient per event (`enqueueOutbox`). The
background worker (`runOutboxWorker`, embedded in `server.ts` or run via
`npm run worker`) polls `deliveredAt IS NULL` rows and republishes them to the
in-process bus; reconnecting clients replay their backlog through
`listForUser(userId, afterId, limit)`. Indexes on `(userId, createdAt)`,
`(deliveredAt, createdAt)` and `(userId, id)`.

## Presence & typing

**UserPresence** — one row per user (`userId` is the primary key): `status`
(`online | away | offline`), `lastSeenAt`, `connId`.

**TypingSession** — public game statistics. `userId` is nullable (anonymous
play allowed); `resultJson` holds the scored summary, `attemptsJson` the last
≤ 200 word attempts. Indexed on `(userId, createdAt)`.

## Calls

**Call** — `status` walks
`ringing | accepted | active | rejected | cancelled | ended | missed | timeout |
failed`. `initiatorId`/`recipientId` reference the two users;
`startedAt`/`answeredAt`/`endedAt`/`durationMs` record the timeline;
`metadata` JSON holds WebRTC diagnostics (ICE state, TURN usage). Indexes on
`(conversationId, startedAt)`, `(initiatorId, startedAt)`,
`(recipientId, startedAt)` and `status`.

**CallParticipant** — one row per (call, user), unique on the pair: `role`
(`initiator | recipient`), `muted`, join/leave times.

**WebRTCSession** — one row per call (`callId` unique): `sessionState`
(`new | connecting | connected | closed | failed`).

## Audit

**AuditLog** — `(actorId, action, targetType?, targetId?, metadata?, ip?,
userAgent?)`; indexed for actor, action and target lookups. Secret-code
changes are logged with a fingerprint, never the plaintext.

**AdminAccessLog** — every administrator read of someone else's data
(`adminId, action, entityType, entityId, …`); every admin media-byte read is
logged here.

## Access configuration (singleton)

**SecretCodeConfiguration** — a single row (`id = 1`). `codePlaintext` is
stored in the database (never in source control, never in the client bundle,
never logged) because the server must hand the code to the browser after a
challenge — local keystroke matching is a product requirement.
`codeHash`/`codeSalt` verify unlock digests; `epoch` is bumped on rotate so
old sessions die; `unlockCount` tracks successful unlocks.

## Deliberately not in the database

- **Rate-limit counters** — expended in process-local Maps in both providers
  (`data.rateLimits`); limits are per instance.
- **Password-reset tokens** — password reset is not implemented; there is no
  table for it.
- **Media bytes** — under `objectKey` in the storage provider, never in
  Postgres.
- **Admin flag** — derived per request from `ADMIN_UID` / `ADMIN_EMAIL`, not
  stored on the user row.

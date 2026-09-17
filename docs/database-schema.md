# Database schema

Cloud Firestore, accessed exclusively through the Firebase Admin SDK. The
application code never talks to Firestore directly: it uses the repository
interfaces in `lib/data/types.ts`, which have two implementations —
`memory` (development and tests) and `firestore` (production).

## Timestamps

Every timestamp is stored as an **ISO-8601 UTC string** (`2026-09-17T05:30:00.000Z`)
rather than a Firestore `Timestamp`. ISO-8601 sorts lexicographically in
chronological order, so `orderBy` + `startAfter` pagination works with plain
strings, one serialisation shape is shared by the memory provider, the API layer
and any future client, and no timezone conversion is needed anywhere. See
[`decisions.md`](./decisions.md).

## Collections

### `users/{userId}`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Same as the document id (Firebase uid) |
| `name` | string | 2–48 characters, sanitised |
| `email` | string | Unique; lower-cased for lookups |
| `searchKey` | string | Lower-cased name/email prefix index for `GET /users/search` |
| `photoUrl` | string \| null | |
| `status` | `'active' \| 'disabled' \| 'deleted'` | A disabled account cannot sign in or use an existing session |
| `role` | `'user' \| 'admin'` | Informational only — administrator identity comes from `ADMIN_UID` |
| `isAdmin` | boolean | Derived from the environment on every read |
| `lastLoginAt` | string \| null | |
| `passwordHash`, `passwordSalt` | string \| null | **Dev auth only.** Never written when `AUTH_PROVIDER=firebase`; always stripped by `stripSecrets` before any admin response |
| `disabledReason` | string \| null | |
| `createdAt`, `updatedAt` | string | |

### `conversations/{conversationId}`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `participantIds` | `[string, string]` | Exactly two, enforced by `conversationKeyFor()` which throws on a self-conversation |
| `participantKey` | string | `sorted(a, b).join('__')` — makes a duplicate conversation impossible |
| `lastMessage` | `MessagePreview \| null` | Denormalised for the list view |
| `lastMessageAt`, `lastActivityAt` | string | `lastActivityAt` drives list ordering |
| `participants` | map | Per-participant state, keyed by uid |
| `createdAt`, `updatedAt` | string | |

`participants.{uid}` holds `lastReadAt`, `lastReadMessageAt`, `unreadCount`,
`hidden`, `hiddenAt`, `blockedUserIds[]` and `presence` (`state`, `lastSeenAt`).

### `conversations/{conversationId}/messages/{messageId}`

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `messageId` | string | `messageId` duplicates the id so a `collectionGroup` query can find a message without knowing its conversation |
| `conversationId`, `senderId` | string | |
| `type` | `'text' \| 'image' \| 'voice' \| 'call' \| 'system'` | |
| `text` | string \| null | `null` once soft deleted |
| `media` | `MediaView \| null` | Embedded snapshot (never the storage path) |
| `call` | `CallView \| null` | For `type: 'call'` history entries |
| `replyTo` | `ReplyReference \| null` | `messageId`, `senderId`, `type`, `preview`, `createdAt` |
| `deliveryState` | `'sending' \| 'sent' \| 'delivered' \| 'read' \| 'failed'` | `DELIVERY_RANK` prevents a downgrade; `failed → sending` is the only backwards move (a retry) |
| `deliveredAt`, `readAt` | string \| null | |
| `readBy` | string[] | |
| `edited` | boolean | |
| `editedAt` | string \| null | |
| `editHistory` | `MessageEditRecord[]` | `previousText`, `editedAt`, `editedBy` — server side only, never sent to a client |
| `deleted` | boolean | Soft delete |
| `deletedAt`, `deletedBy` | string \| null | |
| `hiddenForUserIds` | string[] | "Delete for me": the row stays for everyone else |
| `clientMessageId` | string | Idempotency key, unique per (conversation, sender) |
| `metadata` | map | `originalText` (preserved on delete, admin only), `blockedByRecipient`, `deletionReason` |
| `createdAt`, `updatedAt` | string | |

### `userConversations/{userId}/items/{conversationId}`

Per-user index so the conversation list is one indexed query:
`conversationId`, `otherUserId`, `lastActivityAt`, `lastMessage` preview,
`unreadCount`, `hidden`. Written whenever a conversation changes for that user.

### `media/{mediaId}`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `ownerId` | string | The uploader |
| `conversationId`, `messageId` | string \| null | `null` until the media is sent |
| `kind` | `'image' \| 'voice'` | |
| `storagePath` | string | `media/{ownerId}/{conversationId|drafts}/{mediaId}.{ext}` — the extension comes from the *sniffed* MIME type, never from client input |
| `mimeType` | string | Sniffed from the magic bytes |
| `sizeBytes`, `width`, `height`, `durationMs` | number \| null | |
| `checksum` | string | SHA-256 of the bytes |
| `viewOnce` | boolean | |
| `viewOnceState` | `'sent' \| 'delivered' \| 'viewable' \| 'viewing' \| 'viewed' \| 'expired' \| 'deleted' \| null` | |
| `viewedAt`, `viewedBy` | string \| null | |
| `deleted`, `deletedAt`, `deletedBy` | boolean / string \| null | Bytes are retained so administrators can still inspect them |
| `createdAt`, `updatedAt` | string | |

### `calls/{callId}`

`id`, `conversationId`, `type: 'audio'`, `initiatorId`, `recipientId`,
`status` (`ringing | accepted | active | ended | missed | rejected | cancelled | failed`),
`startedAt`, `answeredAt`, `endedAt`, `durationMs`, `endReason`
(`hangup | timeout | declined | cancelled | failed | app_hidden | triple_tap`),
`iceServersUsed`, `createdAt`, `updatedAt`.

Terminal states also write a `type: 'call'` message into the conversation, so the
history appears inline (`clientMessageId = call_{callId}` makes that write
idempotent).

### `typingSessions/{sessionId}`

`id`, `userId` (nullable — the game is public), `language`, `durationSeconds`,
`wordsPerMinute`, `accuracy`, `correctWords`, `incorrectWords`,
`totalKeystrokes`, `correctKeystrokes`, `elapsedMs`, `attempts[]`, `createdAt`.

### `adminAuditLogs/{logId}`

`id`, `action`, `actorUid`, `actorEmail`, `targetType`, `targetId`, `metadata`
(map), `ipAddress`, `createdAt`. Append-only; there is no update or delete path
in the application.

### `appConfig/access`

`code`, `digest` (SHA-256 of the code), `salt`, `saltedDigest`, `maxLength`,
`caseSensitive`, `epoch`, `unlockCount`, `updatedBy`, `updatedAt`, `createdAt`.
Read and written only by the Admin SDK.

### `rateLimits/{key}`

`key`, `count`, `windowStartsAt`, `expiresAt`. Fixed-window counters for
`enforceRateLimit`.

## Indexes

`firebase/firestore.indexes.json` declares the composite indexes the queries
need: messages by (`deleted`, `createdAt` desc), by (`senderId`,
`clientMessageId`), by `messageId`, plus collection-group indexes on
`createdAt` and (`senderId`, `createdAt`); calls by (`conversationId`, `status`)
and (`recipientId`, `status`); users by (`status`, `searchKey`); conversation
items by (`hidden`, `lastActivityAt` desc); media by (`deleted`, `kind`,
`createdAt` desc); audit logs by (`action`, `createdAt` desc).

Deploy them with `firebase deploy --only firestore:indexes`.

## Cursors

Pagination cursors are base64url of `${sortKey}|${id}`, so a page boundary is
unambiguous even when two documents share a timestamp.

## Known Firestore limitations

These are constraints of Firestore itself, handled in code and worth knowing:

- **No `OR` across fields.** `FirestoreCalls.list({ userId })` can therefore
  only filter by the initiator; the recipient side is resolved client side from
  the calls already returned, and `findRingingForUser` queries the recipient
  field separately.
- **No substring search.** `FirestoreUsers.search` is prefix-based on
  `searchKey`, and message `q=` search scans the conversation's recent messages
  rather than using a full-text index.
- **Collection-group queries need an explicit index**, which is why `messageId`
  is duplicated onto each message document.

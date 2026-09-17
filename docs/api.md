# API

All routes live under `/api/v1`. Requests and responses are JSON unless stated
otherwise.

## Envelope

```jsonc
// success
{ "ok": true, "data": { … } }

// failure
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "…", "details": { … } } }
```

`details` is present for `VALIDATION_ERROR` (per-field messages) and for a few
`PRECONDITION_FAILED` responses. Messages are safe to show to a user; codes are
what client logic should branch on.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Malformed request that passed validation (e.g. an empty message body) |
| 401 | `UNAUTHENTICATED` | No or invalid credentials |
| 403 | `ACCESS_REQUIRED` | No valid access session (the browser must unlock first) |
| 403 | `FORBIDDEN` | Authenticated but not allowed |
| 404 | `NOT_FOUND` | Missing resource — also returned instead of 403 where revealing existence would leak information |
| 409 | `CONFLICT` | Duplicate (e.g. an existing `clientMessageId`) |
| 412 | `PRECONDITION_FAILED` | State does not allow the action (edit window closed, photo already viewed, challenge expired) |
| 413 | `PAYLOAD_TOO_LARGE` | Upload over the limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Bytes are not an allowed image/audio type |
| 422 | `VALIDATION_ERROR` | Zod validation failed |
| 429 | `RATE_LIMITED` | Too many requests; `retryAfterSeconds` in `details` |
| 500 | `INTERNAL` | Unexpected — details are logged server side, never returned |

## Authentication

Two mechanisms are supported and can be combined:

- **Access session** — httpOnly cookie `mt_access`, issued by
  `POST /access/unlock`, signed with `APP_SECRET`, 30-minute TTL, carrying the
  configuration `epoch`.
- **User session** — httpOnly cookie `mt_session` (HS256, `AUTH_PROVIDER=dev`)
  or `Authorization: Bearer <Firebase ID token>` (`AUTH_PROVIDER=firebase`).

In the table below:

- **public** — no credentials required
- **auth** — `requireAuthenticatedAccess`: valid access session **and** verified user
- **admin** — `requireAdminAccess`: both, plus the configured administrator identity

## Access

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /access/challenge` | public | Starts a typing-game session. Returns `{ challenge: { challengeToken, code, epoch, maxLength, caseSensitive, expiresAt, sessionTtlMs } }`. The plaintext code is returned because the match happens in the browser; it is never an authorisation decision. Rate limited to 20/min. |
| `POST /access/unlock` | public | Body `{ challengeToken, digest }` where `digest` is the SHA-256 hex of the typed code. Sets the `mt_access` cookie. The challenge token is single-use. Rate limited to 10/min. |
| `GET /access/status` | public | Returns `{ status, unlocked, session }`; `unlocked` tells a reloading browser whether its cookie is still valid for the current epoch. |
| `POST /access/lock` | public | Revokes the access session and clears the cookie. |

## Authentication

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /auth/register` | public (access session required to enter the chat) | Body `{ name, email, password, confirmPassword }`. Returns `{ user, token, cookieSession, accessGranted }`. Rate limited to 5/10 min. |
| `POST /auth/login` | public | Body `{ email, password }`. Wrong password, unknown email and disabled account all return the same 401. Rate limited to 8/10 min per email. |
| `POST /auth/reauthenticate` | session required, access optional | Body `{ password }`. Binds the access session to the user on success. With Firebase, requires `authTime` within 5 minutes. Rate limited to 6/10 min. |
| `POST /auth/logout` | public | Clears the session cookie. |
| `GET /auth/me` | public | `{ user }` or `{ user: null }` — 200 either way so a client can tell "signed out" from "API broken". |
| `PATCH /auth/profile` | auth | Body `{ name?, photoUrl? }`. |
| `POST /auth/password-reset` | public | Body `{ email }`. Always returns `{ sent: true }`. Rate limited to 3/30 min per email. |

## Users

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /users/search?q=&limit=` | auth | Prefix search by name or email. Returns `{ items: [{ id, name, photoUrl, status }] }` — never another user's email address. |
| `POST /users/presence` | auth | Body `{ presence: 'online'|'away'|'offline' }`. |

## Conversations

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /conversations?limit=&cursor=&includeHidden=` | auth | Paginated list with preview, unread count, last activity and the other participant's presence. |
| `POST /conversations` | auth | Body `{ participantId }`. Idempotent: the same pair always resolves to the same conversation (keyed by the sorted participant ids). |
| `GET /conversations/{id}` | auth | Full conversation view. Non-participants get 404. |
| `GET /conversations/{id}/messages?limit=&before=&after=&q=` | auth | Paginated messages, newest last. |
| `POST /conversations/{id}/read` | auth | Body `{ lastReadMessageAt, lastReadMessageId? }`; clears the unread counter. |
| `POST /conversations/{id}/visibility` | auth | Body `{ hidden }` — hide/show the conversation from your own list. |
| `POST /conversations/{id}/block` | auth | Body `{ blockedUserId, blocked }`. |
| `POST /conversations/{id}/typing` | auth | Body `{ isTyping }`. |
| `POST /conversations/{id}/messages/delivery` | auth | Body `{ messageIds, state: 'delivered'|'read' }`. Receipts from the author are ignored. |
| `GET /conversations/{id}/events` | auth | SSE stream of `message.created`, `message.updated`, `message.deleted`, `typing`, `presence` and `media.viewed` events for this conversation. |

## Messages

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /messages` | auth | Body `{ conversationId, type, text?, mediaId?, viewOnce?, replyTo?, clientMessageId }`. `clientMessageId` makes a retry idempotent. |
| `GET /messages/{id}` | auth | Re-reads one message (used to recover from a failed optimistic update). |
| `PATCH /messages/{id}` | auth | Body `{ text }`. Author only, within 2 minutes; otherwise 403 / 412. |
| `DELETE /messages/{id}` | auth | Body `{ scope: 'everyone'|'me', reason? }`. Soft delete: the row survives for administrators. |

## Media

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /media/upload-intent` | auth | Body `{ kind, mimeType, sizeBytes, durationMs?, width?, height? }` → `{ mediaId, … }`. |
| `POST /media/{id}/upload` | auth | `multipart/form-data` with a `file` field. The declared MIME type is ignored for the decision: the type is sniffed from the magic bytes and the size is re-checked. |
| `POST /media/messages` | auth | Body `{ conversationId, mediaId, type, caption?, viewOnce?, clientMessageId }`. |
| `GET /media/{id}` | auth | Media metadata. |
| `GET /media/{id}/content` | auth | The bytes. `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. For view-once media this is the single read that flips `viewing → viewed`. |
| `POST /media/{id}/view` | auth | Claims the one view. Atomic: concurrent taps produce exactly one success. |
| `POST /media/{id}/viewed` | auth | Client acknowledgement after the overlay closes. |
| `DELETE /media/{id}` | auth | Soft delete (`reason?`). Bytes are retained for administrators. |

## Calls

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /calls` | auth | Body `{ conversationId }` → creates a ringing call and notifies the recipient over SSE. |
| `GET /calls?conversationId=&limit=` | auth | Call history (also written into the conversation as `type: 'call'` messages). |
| `POST /calls/{id}/signal` | auth | Body `{ kind: 'offer'|'answer'|'ice'|'mute'|'unmute', payload }` — the only signalling channel; both peers must be participants. |
| `POST /calls/{id}/accept` | auth | Recipient only. |
| `POST /calls/{id}/reject` | auth | Recipient only. |
| `POST /calls/{id}/end` | auth | Body `{ reason }`. A ringing call ended by the initiator is `cancelled`, by timeout `missed`. |
| `GET /calls/ice-servers` | auth | STUN/TURN configuration from the environment. Never exposed publicly. |
| `GET /calls/events` | auth | SSE stream of incoming calls, signals and state changes for the signed-in user. |

## Typing game

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /typing/sessions` | public | Body `{ language, durationSeconds, attempts, … }`. Stores the scored result for the (public) game statistics. Rate limited to 30/min. |

## Administration

Every route below is `admin`: a valid access session, a verified user, and the
uid or email configured as `ADMIN_UID` / `ADMIN_EMAIL`. Administrators are **not**
exempt from the typing-game gate.

| Method & path | Purpose |
| --- | --- |
| `GET /admin/dashboard` | User, conversation, message, media, call and typing-session counts plus recent activity. |
| `GET /admin/secret-code` | `{ status: { configured, length, maxLength, caseSensitive, epoch, unlockCount, updatedAt } }`. The code itself is never returned. |
| `POST /admin/secret-code` | Body `{ code, confirmCode, strategy: 'rotate'|'replace' }`. `rotate` bumps the epoch and signs everyone out. Audited with a fingerprint, never the plaintext. |
| `GET /admin/users?q=&status=&limit=&cursor=` | Search and list users. Password hashes and salts are stripped. |
| `GET /admin/users/{id}` | One user record. |
| `POST /admin/users/{id}/status` | Body `{ status: 'active'|'disabled', reason? }`. The administrator's own account cannot be disabled. |
| `POST /admin/conversations/inspect` | Body `{ participantA, participantB }` → the conversation plus its messages **including deleted ones**. Writes an audit entry. |
| `GET /admin/conversations/{id}/messages?q=&includeDeleted=` | Message inspection with `metadata.originalText` for deleted rows. |
| `GET /admin/media?kind=&viewOnceOnly=&includeDeleted=` | Media inspection. |
| `GET /admin/media/{id}/content` | Media bytes. **Every** admin media read is audited. |
| `GET /admin/calls?conversationId=&limit=` | Call history with status, duration and end reason. |
| `GET /admin/audit-logs?action=&actorUid=&limit=` | The audit log, newest first. |

## Health

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | public | `{ status, version, dataProvider, authProvider, storageProvider, access: { configured, epoch, maxLength } }`. Never includes the secret code. |

## Rate limits

Fixed windows, keyed by client IP (from `x-forwarded-for` / `x-real-ip`) plus
route, plus an optional subject. Stored in the data provider, so they work with
both the memory and Firestore back ends.

| Key | Limit | Window | Subject |
| --- | --- | --- | --- |
| `access:challenge` | 20 | 60 s | — |
| `access:unlock` | 10 | 60 s | — |
| `auth:register` | 5 | 10 min | — |
| `auth:login` | 8 | 10 min | email |
| `auth:reauth` | 6 | 10 min | — |
| `auth:reset` | 3 | 30 min | email |
| `typing:submit` | 30 | 60 s | — |
| everything else | `RATE_LIMIT_MAX` (default 120) | `RATE_LIMIT_WINDOW_MS` (default 60 s) | — |

## Server-sent events

`GET /conversations/{id}/events` and `GET /calls/events` return
`text/event-stream` with `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no`. Events are JSON in the `data:` field:

```
event: message.created
data: {"conversationId":"c_1","message":{…},"forUserId":"u_2"}
```

The conversation stream is filtered per viewer server side, so one event name
never leaks another participant's content.

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

| Status | Code                     | Meaning                                                                                          |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------ |
| 400    | `BAD_REQUEST`            | Malformed request that passed validation (e.g. an empty message body)                            |
| 401    | `UNAUTHENTICATED`        | No or invalid credentials                                                                        |
| 403    | `ACCESS_REQUIRED`        | No valid access session (the browser must unlock first)                                          |
| 403    | `FORBIDDEN`              | Authenticated but not allowed                                                                    |
| 404    | `NOT_FOUND`              | Missing resource — also returned instead of 403 where revealing existence would leak information |
| 409    | `CONFLICT`               | Duplicate (e.g. an existing `clientMessageId`)                                                   |
| 412    | `PRECONDITION_FAILED`    | State does not allow the action (edit window closed, photo already viewed, challenge expired)    |
| 413    | `PAYLOAD_TOO_LARGE`      | Upload over the limit                                                                            |
| 415    | `UNSUPPORTED_MEDIA_TYPE` | Bytes are not an allowed image/audio type                                                        |
| 422    | `VALIDATION_ERROR`       | Zod validation failed                                                                            |
| 429    | `RATE_LIMITED`           | Too many requests; `retryAfterSeconds` in `details`                                              |
| 500    | `INTERNAL`               | Unexpected — details are logged server side, never returned                                      |

## Authentication

Two mechanisms are supported and can be combined:

- **Access session** — httpOnly cookie `mt_access`, issued by
  `POST /access/unlock`, signed with `APP_SECRET`, 30-minute TTL, carrying the
  configuration `epoch`.
- **User session** — an opaque 256-bit token, kept hashed in the database,
  sent either as the httpOnly cookie `mt_session` (how the browser sends it;
  `EventSource` streams can only send the cookie) or as
  `Authorization: Bearer <token>` (API and WebSocket clients). Sessions live
  `SESSION_DURATION_HOURS` (default 336 = two weeks) and are revoked
  server-side on logout.

In the table below:

- **public** — no credentials required
- **auth** — `requireAuthenticatedAccess`: valid access session **and** verified user
- **admin** — `requireAdminAccess`: both, plus the configured administrator identity

## Access

| Method & path            | Auth   | Purpose                                                                                                                                                                                                                                                                            |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /access/challenge` | public | Starts a typing-game session. Returns `{ challenge: { challengeToken, code, epoch, maxLength, caseSensitive, expiresAt, sessionTtlMs } }`. The plaintext code is returned because the match happens in the browser; it is never an authorisation decision. Rate limited to 20/min. |
| `POST /access/unlock`    | public | Body `{ challengeToken, digest }` where `digest` is the SHA-256 hex of the typed code. Sets the `mt_access` cookie. The challenge token is single-use. Rate limited to 10/min.                                                                                                     |
| `GET /access/status`     | public | Returns `{ status, unlocked, session }`; `unlocked` tells a reloading browser whether its cookie is still valid for the current epoch.                                                                                                                                             |
| `POST /access/lock`      | public | Revokes the access session and clears the cookie.                                                                                                                                                                                                                                  |

## Authentication

Every route below identifies the caller from the verified session token only —
a user id, uid or role in a body or query string is never trusted. Passwords
are accepted only by `POST /auth/register` and `POST /auth/login`, sent in the
JSON body over TLS and verified server-side against an Argon2id hash.

| Method & path               | Auth                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`       | public (access session required to enter the chat) | Body `{ name, email, password }`. Creates the user with an Argon2id-hashed password and sets `mt_session`. Returns `{ user, token: null, cookieSession: true, accessGranted, created }`. Rate limited to 5/10 min per email. |
| `POST /auth/login`          | public                                             | Body `{ email, password }`. Verifies the password against the stored Argon2id hash and sets `mt_session`. Wrong password, unknown email and disabled account all produce the same 401 `UNAUTHENTICATED` with a generic message, so accounts cannot be enumerated. Rate limited to 8/10 min per email.                                                                  |
| `POST /auth/reauthenticate` | session required, access optional                  | Body `{ password }`. Re-verifies the caller's password, re-mints `mt_session` and binds the access session to the user. Rate limited to 6/10 min.                                                                                                                                                                                                                      |
| `POST /auth/logout`         | public                                             | Revokes the caller's session server-side (it stops authorising immediately) and clears `mt_session` and `mt_access`.                                                                                                                                                                                                                                                   |
| `GET /auth/me`              | public                                             | `{ user }` or `{ user: null }` — 200 either way so a client can tell "signed out" from "API broken".                                                                                                                                                                                                                                                                   |
| `PATCH /auth/profile`       | auth                                               | Body `{ name?, photoUrl? }`.                                                                                                                                                                                                                                                                                                                                           |

Registration status codes are what make the sign-up UI honest — the client
branches on them instead of guessing:

| Status | `created` | Meaning | Client behaviour |
| --- | --- | --- | --- |
| `201` | `true` | New account, session cookie set. | Signed in. |
| `200` | `false` | Email already existed **and** the password matched, so a session was (re-)issued. | Signed in. This is what a double-submitted form gets. |
| `401` | — | Email exists but the password did not match. Generic message; indistinguishable from an unknown email. | Show "wrong password", never "cannot create account". |
| `422` | — | Validation or password-policy failure. | Show the field errors. |
| `429` | — | Rate limited. | Ask the caller to wait. |
| `500` | — | The row could not be written, or the session could not be stored. **The only status that may report "cannot create account".** | Surface the error and let the caller retry; a retry that lands on `200` is a correct outcome. |

The browser sends exactly one `POST /auth/register` per submit. Even so, the
route is idempotent, so a retried or duplicated request can never report a
failure for an account that exists.

There is no password-reset route: reset by email is not implemented, and the
sign-in UI reports "not configured" rather than pretending to send mail.

## Users

| Method & path                 | Auth | Purpose                                                                                                                     |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| `GET /users/search?q=&limit=` | auth | Prefix search by name or email. Returns `{ items: [{ id, name, photoUrl, status }] }` — never another user's email address. |
| `POST /users/presence`        | auth | Body `{ presence: 'online'                                                                                                  | 'away' | 'offline' }`. |

## Conversations

| Method & path                                               | Auth | Purpose                                                                                                                                      |
| ----------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /conversations?limit=&cursor=&includeHidden=`          | auth | Paginated list with preview, unread count, last activity and the other participant's presence.                                               |
| `POST /conversations`                                       | auth | Body `{ participantId }`. Idempotent: the same pair always resolves to the same conversation (keyed by the sorted participant ids).          |
| `GET /conversations/{id}`                                   | auth | Full conversation view. Non-participants get 404.                                                                                            |
| `GET /conversations/{id}/messages?limit=&before=&after=&q=` | auth | Paginated messages, newest last.                                                                                                             |
| `POST /conversations/{id}/read`                             | auth | Body `{ lastReadMessageAt, lastReadMessageId? }`; clears the unread counter.                                                                 |
| `POST /conversations/{id}/visibility`                       | auth | Body `{ hidden }` — hide/show the conversation from your own list.                                                                           |
| `POST /conversations/{id}/block`                            | auth | Body `{ blockedUserId, blocked }`.                                                                                                           |
| `POST /conversations/{id}/typing`                           | auth | Body `{ isTyping }`.                                                                                                                         |
| `POST /conversations/{id}/messages/delivery`                | auth | Body `{ messageIds, state: 'delivered'                                                                                                       | 'read' }`. Receipts from the author are ignored. |
| `GET /conversations/{id}/events`                            | auth | SSE stream of `message.created`, `message.updated`, `message.deleted`, `typing`, `presence` and `media.viewed` events for this conversation. |

## Messages

| Method & path           | Auth | Purpose                                                                                                                             |
| ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /messages`        | auth | Body `{ conversationId, type, text?, mediaId?, viewOnce?, replyTo?, clientMessageId }`. `clientMessageId` makes a retry idempotent. |
| `GET /messages/{id}`    | auth | Re-reads one message (used to recover from a failed optimistic update).                                                             |
| `PATCH /messages/{id}`  | auth | Body `{ text }`. Author only, within 2 minutes; otherwise 403 / 412.                                                                |
| `DELETE /messages/{id}` | auth | Body `{ scope: 'everyone'                                                                                                           | 'me', reason? }`. Soft delete: the row survives for administrators. |

## Media

| Method & path               | Auth | Purpose                                                                                                                                                             |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /media/upload-intent` | auth | Body `{ kind, mimeType, sizeBytes, durationMs?, width?, height? }` → `{ mediaId, … }`.                                                                              |
| `POST /media/{id}/upload`   | auth | `multipart/form-data` with a `file` field. The declared MIME type is ignored for the decision: the type is sniffed from the magic bytes and the size is re-checked. |
| `POST /media/messages`      | auth | Body `{ conversationId, mediaId, type, caption?, viewOnce?, clientMessageId }`.                                                                                     |
| `GET /media/{id}`           | auth | Media metadata.                                                                                                                                                     |
| `GET /media/{id}/content`   | auth | The bytes. `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. For view-once media this is the single read that flips `viewing → viewed`.                 |
| `POST /media/{id}/view`     | auth | Claims the one view. Atomic: concurrent taps produce exactly one success.                                                                                           |
| `POST /media/{id}/viewed`   | auth | Client acknowledgement after the overlay closes.                                                                                                                    |
| `DELETE /media/{id}`        | auth | Soft delete (`reason?`). Bytes are retained for administrators.                                                                                                     |

## Calls

| Method & path                       | Auth | Purpose                                                                                       |
| ----------------------------------- | ---- | --------------------------------------------------------------------------------------------- | -------- | ----- | ------ | ------------------------------------------------------------------------------------ |
| `POST /calls`                       | auth | Body `{ conversationId }` → creates a ringing call and notifies the recipient over SSE.       |
| `GET /calls?conversationId=&limit=` | auth | Call history (also written into the conversation as `type: 'call'` messages).                 |
| `POST /calls/{id}/signal`           | auth | Body `{ kind: 'offer'                                                                         | 'answer' | 'ice' | 'mute' | 'unmute', payload }` — the only signalling channel; both peers must be participants. |
| `POST /calls/{id}/accept`           | auth | Recipient only.                                                                               |
| `POST /calls/{id}/reject`           | auth | Recipient only.                                                                               |
| `POST /calls/{id}/end`              | auth | Body `{ reason }`. A ringing call ended by the initiator is `cancelled`, by timeout `missed`. |
| `GET /calls/ice-servers`            | auth | STUN/TURN configuration from the environment. Never exposed publicly.                         |
| `GET /calls/events`                 | auth | SSE stream of incoming calls, signals and state changes for the signed-in user.               |

## Typing game

| Method & path           | Auth   | Purpose                                                                                                                                                                                                                                                               |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /typing/sessions` | public | Body `{ result, attempts }`: `result` is the scored summary (`language`, `durationSeconds`, `wordsPerMinute`, `accuracy`, keystroke counts) and `attempts` the last ≤ 200 word attempts. Stores the summary for the (public) game statistics. Rate limited to 30/min. |

## Administration

Every route below is `admin`: a valid access session, a verified user, and the
uid or email configured as `ADMIN_UID` / `ADMIN_EMAIL`. Administrators are **not**
exempt from the typing-game gate.

| Method & path                                               | Purpose                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /admin/dashboard`                                      | User, conversation, message, media, call and typing-session counts plus recent activity.                                          |
| `GET /admin/secret-code`                                    | `{ status: { configured, length, maxLength, caseSensitive, epoch, unlockCount, updatedAt } }`. The code itself is never returned. |
| `POST /admin/secret-code`                                   | Body `{ code, confirmCode, strategy: 'rotate'                                                                                     | 'replace' }`. `rotate` bumps the epoch and signs everyone out. Audited with a fingerprint, never the plaintext. |
| `GET /admin/users?q=&status=&limit=&cursor=`                | Search and list users. Password hashes and salts are stripped.                                                                    |
| `GET /admin/users/{id}`                                     | One user record.                                                                                                                  |
| `POST /admin/users/{id}/status`                             | Body `{ status: 'active'                                                                                                          | 'disabled', reason? }`. The administrator's own account cannot be disabled.                                     |
| `POST /admin/conversations/inspect`                         | Body `{ participantA, participantB }` → the conversation plus its messages **including deleted ones**. Writes an audit entry.     |
| `GET /admin/conversations/{id}/messages?q=&includeDeleted=` | Message inspection with `metadata.originalText` for deleted rows.                                                                 |
| `GET /admin/media?kind=&viewOnceOnly=&includeDeleted=`      | Media inspection.                                                                                                                 |
| `GET /admin/media/{id}/content`                             | Media bytes. **Every** admin media read is audited.                                                                               |
| `GET /admin/calls?conversationId=&limit=`                   | Call history with status, duration and end reason.                                                                                |
| `GET /admin/audit-logs?action=&actorUid=&limit=`            | The audit log, newest first.                                                                                                      |

## Health

| Method & path | Auth   | Purpose                                                                                                                                                                           |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health` | public | `{ ok, version, dataProvider, authProvider ('argon2-session'), storageProvider, time, access: { epoch, maxLength, caseSensitive, configured } }`. Never includes the secret code. |

## Rate limits

Fixed windows, keyed by client IP (from `x-forwarded-for` / `x-real-ip`) plus
route, plus an optional subject. Counted in memory in both providers
(`data.rateLimits`), so limits are per instance on multi-instance deployments.

| Key                | Limit                          | Window                                | Subject |
| ------------------ | ------------------------------ | ------------------------------------- | ------- |
| `access:challenge` | 20                             | 60 s                                  | —       |
| `access:unlock`    | 10                             | 60 s                                  | —       |
| `auth:register`    | 5                              | 10 min                                | —       |
| `auth:login`       | 8                              | 10 min                                | email   |
| `auth:reauth`      | 6                              | 10 min                                | —       |
| `typing:submit`    | 30                             | 60 s                                  | —       |
| everything else    | `RATE_LIMIT_MAX` (default 120) | `RATE_LIMIT_WINDOW_MS` (default 60 s) | —       |

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

Message events delivered on these streams:

- `message.created` — a new message, pushed to the transport **before** the
  database write completes (notify-first delivery).
- `message.updated` — an edit.
- `message.deleted` — a deletion.
- `message.retracted` — a delivered message whose storage failed and was rolled
  back. Recipients remove the bubble; the sender's client marks it retryable.
  Payload: `{ conversationId, messageId, clientMessageId, senderId, reason,
  forUserId }`.
- `message.delivered` / `message.read` — receipts for the sender.
- `conversation.updated` — the refreshed conversation row (preview, timestamp,
  unread count) after a send is persisted.

## WebSocket (standalone server only)

`server.ts` (`npm run serve`) also accepts WebSocket connections at
`/api/v1/ws`. Authenticate with the `mt_session` cookie or an
`Authorization: Bearer <token>` header during the upgrade handshake;
unauthenticated upgrades get `401` and anything off-path is dropped.

Client → server frames are JSON:

- `{ "type": "subscribe", "conversations": ["c_1", …], "since": "<eventId>"? }`
  — (re)subscribes to those conversations, replays missed outbox events after
  `since` (or `?since=` from the upgrade URL), and is acknowledged with
  `{ topic: 'system', type: 'subscribed', payload: { conversations, refused,
  replayed, lastEventId } }`. `refused` lists the ids the caller is not a member
  of; `replayed` counts the events just resent.
- `{ "type": "typing", "conversationId": "c_1", "isTyping": true }` — ephemeral,
  never persisted. The server re-stamps `userId` with the **authenticated**
  sender, so a client cannot type as somebody else.
- `{ "type": "ping" }` — answered with `{ topic: 'system', type: 'pong' }`. The
  browser client also pings every 25 s; the server closes a socket silent for
  longer than that.

Server → client: a `{ topic: 'system', type: 'hello', payload: { userId,
serverTime } }` greeting, then the same bus events the SSE streams carry
(messages, typing, presence, calls, access revocation). Invalid frames get
`{ topic: 'system', type: 'error', payload: { code: 'BAD_FRAME' } }` and the
socket stays open.

Three guarantees worth knowing before changing this code:

1. **Membership is checked per subscription**, not per connection. A socket
   authenticated as Alice can still not subscribe to Bob's conversation.
2. **Every frame is filtered to the recipient** before it is written, so an
   event rendered for the peer never reaches the author's socket (and vice
   versa).
3. **Multiple sockets per user are supported.** A second tab does not evict the
   first; both receive the same events, and each tracks its own `since` cursor.

Reconnects use exponential backoff (1 s → 30 s, with jitter) and send the last
event id, so no durable event is delivered twice and none is skipped. When the
socket cannot be established at all, the browser client switches to SSE
automatically — which is the path `next dev` uses, since only `npm run serve`
mounts the upgrade handler.

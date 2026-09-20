# Architectural decisions

Each entry records the decision, the alternative that was rejected, and why.

## 1. A repository layer instead of calling Prisma directly

`lib/data/types.ts` defines the repository interfaces; `memory` and `prisma`
implement them. Services never import the Prisma client.

- _Alternative rejected_: calling Prisma from services. It would make the app
  impossible to test without a database, and would couple every use case to a
  vendor SDK.
- _Consequence_: the whole API surface is testable against the memory provider in
  milliseconds, and a future React Native client reuses the same API.

## 2. ISO-8601 strings at every boundary

Timestamps cross the API, the domain layer and the providers as ISO-8601
strings. Lexicographic order equals chronological order, so cursors are readable
and one serialisation shape is shared by both providers and the API layer; the
Prisma provider converts to `DateTime` columns at the last step.

- _Alternative rejected_: database `Date` objects. They would need conversion at
  every boundary and behave differently in the memory provider.

## 3. The secret code is delivered to the browser

The match has to happen where the keystrokes are. `POST /access/challenge`
therefore returns the plaintext code, and it is documented as public
information.

- _Alternative rejected_: server-side matching of every keystroke. It would leak
  typing to the network in real time, add a request per key, and still not be a
  meaningful security boundary.
- _Consequence_: the code gates **UI only**. Every route independently enforces
  `requireAccess` + `requireUser`; admin routes also enforce `requireAdminAccess`.

## 4. Epoch-based session invalidation

Challenges and access sessions are signed with the configuration `epoch`.
Rotating the code bumps the epoch, which invalidates every outstanding token
without a session table or a revocation list.

- _Alternative rejected_: storing and deleting sessions. It costs a read per
  request and still needs an expiry sweep.

## 5. The access cookie is bound to the user

`accessBindingCookie()` returns `null` when the browser never unlocked, or when
its access session predates the current epoch, so register/login can never be
used to bypass the typing-game gate.

## 6. One-time views are claimed in a transaction

`claimViewOnce` moves `delivered|viewable → viewing` atomically — inside a
Prisma `$transaction` against Postgres, under the single-threaded event loop
in the memory provider — and returns `claimed: false` for a loser.
`GET /media/{id}/content` serves bytes only while the state is `viewing`, then
flips it to `viewed` — so exactly one read of the bytes is possible. `viewing`
also acts as a crash guard: a client that opened the image and never confirmed
leaves it unrecoverable rather than re-openable.

- _Tested_: two simultaneous `POST /media/{id}/view` calls produce exactly one
  200 (`tests/api/media.test.ts`).

## 7. Deletion is soft, and the original text is preserved

`softDeleteMessage` sets `deleted`, `deletedAt`, `deletedBy`, nulls `text` and
keeps the original in `metadata.originalText`. "Delete for me" adds the viewer
to `hiddenForUserIds` (stored inside the metadata JSON) instead, so the row
stays visible to the other participant.

- _Alternative rejected_: hard deletes. They would contradict the requirement
  that administrators can inspect deleted content.

## 8. Uploads are validated by magic bytes

`sniffMimeType` matches signatures for JPEG, PNG, GIF, WebP, WebM, OGG, MP3 and
M4A, and disambiguates MP4 audio from video by brand. The declared MIME type is
used only as a hint.

- _Alternative rejected_: trusting `File.type` or the file extension. Both are
  attacker controlled.

## 9. Two-step media upload

`POST /media/upload-intent` creates the record and returns a `mediaId`;
`POST /media/{id}/upload` receives the bytes. This keeps the (large) body out of
the JSON API, lets the client show progress and cancel, and makes a retry
idempotent.

## 10. SSE over an in-process bus, with a documented upgrade path

`lib/realtime/bus.ts` + `createEventStream` give realtime updates with no extra
infrastructure. The stream is filtered per viewer server side, and every state
change is also persisted to the `OutboxEvent` table so reconnecting clients can
replay what they missed (`?since=<eventId>`).

- _Known limitation_: on a multi-instance deployment, live events only reach
  clients connected to the same instance. The upgrade path is a single shared
  outbox poller — Postgres `LISTEN`/`NOTIFY` or Redis Streams — behind the same
  `publish()` call site, which is why every state change already goes through it.

## 11. `clientMessageId` as the idempotency key

A retried send with the same key returns the original message instead of creating
a duplicate. Call records reuse the mechanism with `call_{callId}`.

## 12. Next 16 and `proxy.ts`

Next 16 replaced `middleware.ts` with `proxy.ts` exporting `proxy`. It is used
only for security headers and a request id — never for authorisation, because
edge code cannot verify session tokens against the database.

Next 15.5.x carries a critical advisory (RCE in the React flight protocol) that
is fixed in 16.x, which is why the project pins Next 16 rather than staying on 15.

## 13. Internal packages ship TypeScript sources

`transpilePackages` compiles `@mt/*` together with the app, so there is no build
step for the packages and one source of truth for the types shared with a future
mobile client.

## 14. ~~Dual auth providers behind one interface~~ — historical

`AuthProvider` once had `dev` (scrypt-hashed passwords + an HS256 session
cookie) and `firebase` (ID token) implementations behind one interface,
selected by `AUTH_PROVIDER`. The project later standardised on Firebase-only
auth — and then, because a self-hosted password system fits this private 1:1
app better than a cloud identity dependency, replaced it with the current
Argon2 + database-session design (see #19). No provider switch, cloud project,
or emulator remains.

## 15. Rate limiting in the data provider

Counters live behind `data.rateLimits`, counted in process-local Maps, so limits
work identically with the memory and Prisma back ends and no extra service
(Redis/Upstash) is required. The trade-off — per-instance counters — is
acceptable because these limits exist to blunt brute forcing, not to meter
traffic.

## 16. Errors are opaque by design

Login and register return identical responses for wrong password, unknown email
and disabled account — the server logs the specific `auth.login_*` line, the
client sees one generic message. Non-existent resources often return 404 rather
than 403 so existence is not revealed.

## 17. Route handlers are plain functions

Each `route.ts` exports `GET`/`POST`/… as functions taking a `Request`. The
integration tests construct a `Request`, call the handler and assert on the
`Response` — no HTTP server, no mocking of the framework.

## 18. No `next/image` for user media

Media is served by an authorised route with `no-store`. `images.remotePatterns`
is empty on purpose: routing user content through the optimiser would create an
unauthenticated fetch path.

## 19. Self-hosted Argon2 sessions (no cloud identity)

Email/password authentication is verified server-side, in every environment,
against an Argon2id hash stored in this application's own database. There is no
provider switch, no development authentication and no cloud dependency.

- The password travels in the register/login POST body over TLS and is never
  logged. Only the hash is persisted — and it never leaves the data layer:
  `UserRecord` has no password field, and the column is stripped from every
  admin response too.
- A successful login issues an opaque 256-bit token, stored hashed in
  `UserSession`, delivered as the httpOnly `mt_session` cookie (browsers) or
  an `Authorization: Bearer` token (API/WebSocket clients). Sessions expire
  after `SESSION_DURATION_HOURS` and are revoked server-side on logout, so a
  copied token stops working.
- SSE streams authenticate with the cookie, because `EventSource` cannot send
  an `Authorization` header — which is also why the API accepts either
  credential.
- Password reset by email is deliberately **not** implemented: the UI reports
  "not configured" rather than faking mail delivery. Resetting a password is
  an out-of-band operation until a mail transport is wired up.

_Alternatives rejected_: a cloud identity provider (a network dependency, a
second password store and an emulator for what is, in this private 1:1 app, one
table and one hash function — see #14 for the history); a custom JWT/password
system without server-side sessions (cannot revoke a stolen token); trusting a
client-supplied uid (an authentication bypass).

_Cost_: this server is the credential store, so it must be run and backed up
like one — TLS everywhere, strong `APP_SECRET`, Postgres credentials that are
not the dev defaults, and the VPS hardening in `docs/deploy.md`.

## 20. Notify-first message delivery (write-behind persistence)

A sent message is pushed to the live transport the moment it passes
authorisation — **before** anything is written to the database. Delivery
latency is the socket latency, full stop; a slow or congested database can no
longer hold a message hostage.

- Persistence runs write-behind in the same process: message row, media link,
  conversation summary, then durable outbox rows (the reconnect replay), and
  finally a `conversation.updated` fan-out that refreshes both conversation
  lists. `waitForPendingMessageWrites()` lets tests and shutdown wait the
  background jobs out.
- The flip side is explicit: if the insert fails, the already-delivered message
  is **retracted** — every client receives `message.retracted` and removes the
  bubble (the sender's copy becomes retryable). A delivery never outlives its
  storage, and a failed insert deletes what it delivered.
- Idempotency on the hot path is an in-process registry keyed by
  `(conversationId, senderId, clientMessageId)` — a retry returns the original
  response without re-delivering, and without a database round-trip. The
  database unique constraint on the same triple is the cross-process backstop;
  a duplicate that loses the race is recognised at insert time and dropped.
- _Trade-off accepted_: a client that disconnects in the short window between
  the live publish and the outbox write can miss that one event; every other
  path (reconnect replay, pagination, the REST response) still reconciles it.
  Speed of delivery was the explicit priority.

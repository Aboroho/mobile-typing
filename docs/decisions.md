# Architectural decisions

Each entry records the decision, the alternative that was rejected, and why.

## 1. A repository layer instead of calling Firestore directly

`lib/data/types.ts` defines nine repository interfaces; `memory` and
`firestore` implement them. Services never import `firebase-admin`.

- *Alternative rejected*: calling Firestore from services. It would make the app
  impossible to test without an emulator, and would couple every use case to a
  vendor SDK.
- *Consequence*: the whole API surface is testable against the memory provider in
  milliseconds, and a future React Native client reuses the same API.

## 2. ISO-8601 strings instead of Firestore `Timestamp`

Lexicographic order equals chronological order, so `orderBy` + `startAfter`
works with plain strings, cursors are readable, and one serialisation shape is
shared by both providers and the API layer.

- *Alternative rejected*: `Timestamp` objects. They would need conversion at every
  boundary and behave differently in the memory provider.

## 3. The secret code is delivered to the browser

The match has to happen where the keystrokes are. `POST /access/challenge`
therefore returns the plaintext code, and it is documented as public
information.

- *Alternative rejected*: server-side matching of every keystroke. It would leak
  typing to the network in real time, add a request per key, and still not be a
  meaningful security boundary.
- *Consequence*: the code gates **UI only**. Every route independently enforces
  `requireAccess` + `requireUser`; admin routes also enforce `requireAdminAccess`.

## 4. Epoch-based session invalidation

Challenges and access sessions are signed with the configuration `epoch`.
Rotating the code bumps the epoch, which invalidates every outstanding token
without a session table or a revocation list.

- *Alternative rejected*: storing and deleting sessions. It costs a read per
  request and still needs an expiry sweep.

## 5. The access cookie is bound to the user

`accessBindingCookie()` returns `null` when the browser never unlocked, or when
its access session predates the current epoch, so register/login can never be
used to bypass the typing-game gate.

## 6. One-time views are claimed in a transaction

`claimViewOnce` moves `delivered|viewable → viewing` inside `runTransaction` and
returns `claimed: false` for a loser. `GET /media/{id}/content` serves bytes only
while the state is `viewing`, then flips it to `viewed` — so exactly one read of
the bytes is possible. `viewing` also acts as a crash guard: a client that opened
the image and never confirmed leaves it unrecoverable rather than re-openable.

- *Tested*: two simultaneous `POST /media/{id}/view` calls produce exactly one
  200 (`tests/api/media.test.ts`).

## 7. Deletion is soft, and the original text is preserved

`softDeleteMessage` sets `deleted`, `deletedAt`, `deletedBy`, nulls `text` and
keeps the original in `metadata.originalText`. "Delete for me" uses
`hiddenForUserIds` instead, so the row stays visible to the other participant.

- *Alternative rejected*: hard deletes. They would contradict the requirement
  that administrators can inspect deleted content.

## 8. Uploads are validated by magic bytes

`sniffMimeType` matches signatures for JPEG, PNG, GIF, WebP, WebM, OGG, MP3 and
M4A, and disambiguates MP4 audio from video by brand. The declared MIME type is
used only as a hint.

- *Alternative rejected*: trusting `File.type` or the file extension. Both are
  attacker controlled.

## 9. Two-step media upload

`POST /media/upload-intent` creates the record and returns a `mediaId`;
`POST /media/{id}/upload` receives the bytes. This keeps the (large) body out of
the JSON API, lets the client show progress and cancel, and makes a retry
idempotent.

## 10. SSE over an in-process bus, with a documented upgrade path

`lib/realtime/bus.ts` + `createEventStream` give realtime updates with no extra
infrastructure. The stream is filtered per viewer server side.

- *Known limitation*: on a multi-instance deployment, events only reach clients
  connected to the same instance. The upgrade path is Firestore change feeds
  behind the same `publish()` call site, which is why every state change already
  goes through it.

## 11. `clientMessageId` as the idempotency key

A retried send with the same key returns the original message instead of creating
a duplicate. Call records reuse the mechanism with `call_{callId}`.

## 12. Next 16 and `proxy.ts`

Next 16 replaced `middleware.ts` with `proxy.ts` exporting `proxy`. It is used
only for security headers and a request id — never for authorisation, because
edge code cannot verify Firebase tokens against the database.

Next 15.5.x carries a critical advisory (RCE in the React flight protocol) that
is fixed in 16.x, which is why the project pins Next 16 rather than staying on 15.

## 13. Internal packages ship TypeScript sources

`transpilePackages` compiles `@mt/*` together with the app, so there is no build
step for the packages and one source of truth for the types shared with a future
mobile client.

## 14. Dual auth providers behind one interface

`AuthProvider` has `dev` (scrypt + HS256 cookie) and `firebase` (ID token)
implementations. The same routes, services and tests work against both.

- *Alternative rejected*: Firebase-only. It would make local development and CI
  depend on a network service and a real project.

## 15. Rate limiting in the data provider

Counters live behind `data.rateLimits`, so limits behave identically with the
memory and Firestore back ends, and no extra service (Redis/Upstash) is required.
The trade-off — per-instance counters with the memory provider — is acceptable
because these limits exist to blunt brute forcing, not to meter traffic.

## 16. Errors are opaque by design

Login, register and password reset return identical responses for every failure
mode. A disabled account is indistinguishable from a wrong password. Non-existent
resources often return 404 rather than 403 so existence is not revealed.

## 17. Route handlers are plain functions

Each `route.ts` exports `GET`/`POST`/… as functions taking a `Request`. The
integration tests construct a `Request`, call the handler and assert on the
`Response` — no HTTP server, no mocking of the framework.

## 18. No `next/image` for user media

Media is served by an authorised route with `no-store`. `images.remotePatterns`
is empty on purpose: routing user content through the optimiser would create an
unauthenticated fetch path.

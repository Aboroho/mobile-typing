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

## 14. ~~Dual auth providers behind one interface~~ — superseded by #19

`AuthProvider` used to have `dev` (scrypt-hashed passwords + an HS256 session
cookie) and `firebase` (ID token) implementations behind one interface, selected
by `AUTH_PROVIDER`.

- *Alternative rejected at the time*: Firebase-only, because it would make local
  development and CI depend on a network service and a real project.
- *Why it was reversed*: the switch was the direct cause of the registration
  failure this rewrite fixed. With `AUTH_PROVIDER=firebase` and an incomplete
  `NEXT_PUBLIC_FIREBASE_*` config, the browser silently fell back to the dev auth
  client, which never produces an ID token, while the server correctly required
  one — so every sign-up came back `complete the Firebase sign-up first`. Two
  providers also meant two password stores, two session formats and a database
  column (`passwordHash`) that had to be defended everywhere it could leak.
  See decision #19.

## 15. Rate limiting in the data provider

Counters live behind `data.rateLimits`, so limits behave identically with the
memory and Firestore back ends, and no extra service (Redis/Upstash) is required.
The trade-off — per-instance counters with the memory provider — is acceptable
because these limits exist to blunt brute forcing, not to meter traffic.

## 16. Errors are opaque by design

Login and register return identical responses for every failure mode this
application controls. A disabled account is indistinguishable from a wrong
password: both are refused by Firebase before a request reaches the API, and both
are worded the same. Non-existent resources often return 404 rather than 403 so
existence is not revealed.

## 17. Route handlers are plain functions

Each `route.ts` exports `GET`/`POST`/… as functions taking a `Request`. The
integration tests construct a `Request`, call the handler and assert on the
`Response` — no HTTP server, no mocking of the framework.

## 18. No `next/image` for user media

Media is served by an authorised route with `no-store`. `images.remotePatterns`
is empty on purpose: routing user content through the optimiser would create an
unauthenticated fetch path.


## 19. Firebase Authentication only

Email/password authentication is Firebase's, in every environment. There is no
provider switch, no development authentication and no offline fallback.

- The browser is the only place a password exists. `createUserWithEmailAndPassword`
  and `signInWithEmailAndPassword` verify it; the ID token is what travels.
- The API verifies that credential server-side (`verifyIdToken` /
  `verifySessionCookie`, always with `checkRevoked: true`) and takes the uid and
  email **from the verified token**. An `Authorization` header, a body field or a
  query parameter naming a user is never trusted.
- A fresh ID token (`auth_time` within five minutes) is exchanged for a Firebase
  session cookie in `mt_session`. That cookie is what SSE streams authenticate
  with, because `EventSource` cannot send an `Authorization` header — which is
  also why the API accepts either credential.
- Logout revokes the user's Firebase credentials before the browser signs out, so
  a copied cookie stops working. The trade-off is Firebase's: revocation is
  account-wide, so it ends the session on every device, not just this one.
- No password or hash is stored in this application's database; `UserRecord` has
  no such field, and the memory provider has no password store.

*Alternatives rejected*: keeping `AUTH_PROVIDER=dev` (see #14 — it was the root
cause of the failure, and a second password store is a liability this app does not
need); a custom JWT/password system (duplicates Firebase badly); trusting a
client-supplied uid (an authentication bypass).

*Cost*: local development and CI need a Firebase project, or the Auth emulator.
Tests replace the Admin SDK at the `getAdminAuth()` boundary instead, so the
route-handler tests stay honest about the credential flow without a network
service — at the price of not covering Google's own verification code.

## 20. Message identity is the client id; the list is a merge, never an append

The duplicate-message bug (see `docs/messaging-sync.md` §1) came from two
identities for one message: the optimistic row used `clientMessageId` as its `id`
while the stream delivered the server id first, and the list matched by `id`
alone. The fix defines one logical key — `clientMessageId ?? id` — and routes
every input (placeholder, response, stream event, page, reconnect catch-up,
receipt) through pure merge functions in `lib/domain/message-sync.ts`.

- Retries reuse the original `clientMessageId`, so the server's idempotency
  (`findByClientMessageId`) is what prevents a second copy when the first attempt
  actually landed.
- A placeholder never overrides a canonical row; delivery states never move
  backwards; identical input returns the same array so React does not re-render.
- React keys are the same logical key, so a bubble is updated in place when the
  server's copy arrives.

*Alternatives rejected*: suppressing the sender's own `message.created` event
(hides the bug for one tab, breaks a second tab of the same user); delaying the
publish until after the response (turns a race into a slower race); CSS or a
timer to hide the extra row (not a fix).

## 21. Read receipts are a watermark; delivered receipts are explicit

`delivered` means the recipient's device has synchronised the message, so the
client acknowledges exact ids as soon as it has them (batched, one request).
`read` means the message was rendered in a visible document, which the client
detects per bubble with an IntersectionObserver — but it reports a single
watermark (`lastReadMessageAt`), and the server advances every peer message at or
before it. That keeps writes bounded, matches how a thread is actually read
(everything above a visible message has been scrolled past), and lets the sender
receive one event instead of one per message. Only the other participant can
advance a message, and transitions are monotonic, so a client cannot invent or
undo a receipt.

## 22. "Hidden for 60 s", not "lost focus"

The privacy lock used to fire on `blur` and on the first `visibilitychange`.
That made the chat unusable side by side with another window and closed it on a
brief notification swipe. The rule is now: hidden (Page Visibility) for more than
`CHAT_HIDDEN_LOCK_MS`; focus changes are ignored. Because background timers are
unreliable on phones, the moment the page was hidden is stamped (memory +
`sessionStorage`) and compared on every return and on mount, so a suspended or
restored tab is judged by elapsed time rather than by whether a timer managed to
run. The explicit ways to hide instantly — header **Hide** button, double tap on
the message area, the existing triple tap — all share one coordinator
(`hideChat()`), which locks synchronously before any network round trip.

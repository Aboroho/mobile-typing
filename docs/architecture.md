# Architecture

## 1. Setup

**Prerequisites** — Node.js 20.11+, npm 10+. Optional: PostgreSQL 15+ for
persistent data (the memory providers need nothing).

```bash
cp .env.example .env.local
npm install
npm run dev      # http://localhost:3000
```

Nothing else is required: auth, chat, presence and media all run against the
dev server itself. Copying `.env.example` is still recommended so you have the
annotated list of knobs; the dev defaults in `lib/config/server-env.ts` keep
everything else working.

**Demo accounts:**

```bash
npm run seed
```

Registers `ADMIN_EMAIL` (password from `ADMIN_PASSWORD`) and a peer account
through the real registration flow against the configured provider, creates a
conversation between them, and prints the admin uid for `ADMIN_UID`. Refuses to
run in production.

**Environment check:**

```bash
npm run doctor
```

Reports which file each value came from, flags placeholder/short secrets,
validates the Prisma `DATABASE_URL` and S3 credentials when those providers are
selected, and warns when no administrator is configured.

## 2. Local development commands

| Command                                         | Purpose                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                                   | Next.js dev server on `0.0.0.0:3000`                          |
| `npm run test` / `test:watch` / `test:coverage` | Vitest unit + API tests on memory providers                   |
| `npm run e2e`                                   | Playwright; boots `./node_modules/.bin/next dev` on port 3100 |
| `npm run seed`                                  | Demo users (idempotent)                                       |
| `npm run typecheck` / `lint` / `format:check`   | Gates; run before committing                                  |
| `npm run verify`                                | typecheck → test → build                                      |

Tests use per-file in-memory providers — no database required, no cross-file
interference.

## 3. Layout

```
app/                     UI routes + /api/v1/* route handlers (see docs/api.md)
components/              React UI: typing game, chat, admin, shared primitives
hooks/ stores/           Client hooks and Zustand stores
lib/
  types/                 Domain types, enums, limits (pure TS, no deps)
  validation/            Zod schemas for every request (server + reused client-side)
  domain/                Pure business rules: keystroke buffer, scoring, policies,
                         audit, capability tables
  utils/                 Hashing, ids, time, base64, text, wordlists (pure)
  config/                Env parsing for public (`NEXT_PUBLIC_*`) and server config
  api-client/            Typed browser API client (fetch wrapper, retry, SSE)
  auth/ access/ users/ conversations/ messages/ media/ voice/ calls/
  admin/ notify/ rtc/ realtime/ storage/ security/ data/ services/ …  app modules
  prisma.ts              Prisma client singleton (single-flight init/teardown)
  env.ts                 Lazy server-env accessor (avoids import-time throws)
prisma/                  PostgreSQL schema + migrations
public/typing-words/     English + Bengali word lists (static)
server.ts                Standalone server: Next.js + WebSocket + outbox worker
proxy.ts                 Security headers, CSP, request id on every request
instrumentation.ts       Bootstraps the access config on server start
tests/                   Vitest specs mirroring lib/ + app/
e2e/                     Playwright specs
scripts/                 seed-dev.ts, doctor.mjs
```

Import aliases: `@/` → repo root, `@mt/*` → `lib/*`. Path aliases for local
modules; relative imports only for `./` and `../`.

## 4. Request lifecycle (global pattern)

Every API route follows the same shape — `app/api/v1/messages/route.ts` is a
good reference:

1. **Parse input with a Zod schema** (`lib/validation/*`). Invalid bodies → `400
INVALID_BODY` with per-field detail.
2. **Authenticate the caller** (`requireAuth`, lib/auth/require-auth.ts):
   `mt_session` cookie (browser) or `Authorization: Bearer <token>` (API/WS
   clients). Missing → `401 UNAUTHENTICATED`.
3. **Run the service.** Services live in `lib/services/*` and `lib/*/…-service.ts`;
   they enforce business rules, authorisation and rate limits, and never touch
   HTTP.
4. **Touch storage only through `getData()`** — the provider interface in
   `lib/data/*` (memory or Prisma). Media goes through `getStorage()`.
5. **Respond with `lib/api/respond.ts`** (`ok()`, `fail()`): every response is
   `{ ok, requestId, data? | error? }`.

Cross-cutting behaviour in middleware order: `proxy.ts` (request id, security
headers incl. CSP) → route auth → per-endpoint rate limits → service.

**Realtime.** Delivery is **notify-first**: a sent message is published on the
in-process bus (`lib/realtime/bus.ts`) the moment it passes authorisation, so
connected sockets receive it immediately — delivery never waits for a database
write. Persistence then runs write-behind (`lib/services/message-service.ts`):
the message row, media link, conversation summary and the durable outbox rows
are written in the background, followed by a `conversation.updated` fan-out
that refreshes both conversation lists. If the insert fails, the message that
was already delivered is **retracted** — every client receives
`message.retracted` and removes the bubble (the sender keeps it as a retryable
failure) — so a delivery never outlives its storage.

The **outbox is the durable truth** for everything else. A mutation writes an
`OutboxEvent` row (one per recipient), publishes it on the bus, then marks the
rows delivered. `runOutboxWorker()` (`lib/realtime/outbox.ts`) republishes any
row still un-delivered after a short grace period, so a failed publish is
recovered rather than lost. Because every event id is time-ordered, a client
reconnects with `since: <lastEventId>` and the server replays exactly the
missed rows. `LISTEN`/`NOTIFY` is only ever a wake-up hint — a missed
notification delays a delivery by one poll, it never loses one.

Two transports deliver those events:

- **WebSocket** at `/api/v1/ws`, mounted by `server.ts` on the same port as
  Next.js (`lib/ws/server.ts`). Authenticated from the `mt_session` cookie or an
  `Authorization: Bearer` header _before_ the socket is accepted — an
  unauthenticated upgrade is refused with `401`. Frames are described in
  `docs/api.md#websocket`. Per-socket subscriptions are validated against
  conversation membership, and every outbound frame is filtered to the
  recipient, so one socket can never observe another user's conversation.
- **SSE** per conversation (`/conversations/{id}/events`) and per user
  (`/calls/events`). The browser client uses this as an automatic fallback when
  no WebSocket is available (for example behind a proxy that strips upgrades),
  so every durable event still arrives. Note that `npm run dev` boots the
  standalone `server.ts` precisely so the WebSocket works in development;
  plain `next dev`/`next start` cannot mount the upgrade handler.

Typing indicators are the one exception: they are ephemeral by design and never
touch the database. They ride the same socket (or `POST /conversations/{id}/
typing` over REST) and expire client-side after a few seconds.

Multi-instance deployments need a shared bus — the documented upgrade is a
single shared outbox poller driven by Postgres `LISTEN`/`NOTIFY` or Redis
Streams.

Money-quote for contributors: **validate → authenticate → service → provider →
respond**, realtime via bus + outbox, and no direct Prisma/DB access outside the
data providers.

## 5. Access gate and startup check

The public surface is the typing game. Before reconsidering this design, find
the code: unlock logic in `lib/access/*`, gate state in `stores/access-store.ts`,
and the lock triggers in `hooks/use-hide-chat.ts` (which every trigger funnels
into).

**Nothing user-scoped runs before the gate opens.** The session cookie lives for
two weeks and the access session for thirty minutes, so a browser is routinely
_signed in but locked_ — and every protected route answers `403
ACCESS_REQUIRED` in that state. `RootProviders` therefore starts the realtime
transport and the call stream only when `useAccessGateOpen()` is true
(`stores/access-store.ts`), which stops a locked browser from subscribing to
streams it may not read.

Two more rules keep the gate usable (and quiet) on a phone:

- `startChallenge()` is single-flight and retries with backoff, honouring
  `Retry-After`. Reloading no longer multiplies the challenge requests, and a
  rate-limited one re-arms by itself instead of leaving the game with no
  challenge — which made typing the secret code silently do nothing. A failed
  _unlock_ re-arms too, because the server consumes a challenge token per try.
- An SSE stream cannot see _why_ it failed, so both streaming transports ask
  `accessSessionGone()` (`lib/browser/access-session.ts`) after repeated
  failures: a revoked access session ends the stream and returns the app to the
  typing game through the existing `mt:access-required` event, while a network
  problem keeps retrying.

For a phone on the same network, `next.config.ts` also allows local network
hosts in `allowedDevOrigins`: Next.js refuses its dev-only resources (HMR) for
an unlisted host, and a blocked HMR connection leaves the page rendered but
never hydrated — which looks exactly like "the unlock code does nothing".

## 6. Hiding the chat

Three triggers, one handler:

| Trigger                            | Where                                                               | Rule                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header **Hide** button             | `components/messages/chat-screen.tsx`                               | One tap, always available.                                                                                                                         |
| **Double tap** in the message area | `lib/browser/double-tap.ts` + `hooks/use-double-tap.ts`             | Two taps within 350 ms and 48 px of each other, on touch _or_ pointer devices. A single tap never hides anything.                                  |
| **Tab hidden for 60 s**            | `lib/browser/visibility-policy.ts` + `hooks/use-visibility-lock.ts` | `visibilitychange`, `pagehide` and `blur` start the timer; `pageshow`, `focus` and becoming visible cancel it and restore the _full_ grace period. |

Deliberate details, each covered by a test:

- A double tap on an `input`, `textarea`, `button`, `a`, audio/video control or
  anything marked `data-no-double-tap` is ignored — selecting text or tapping
  the emoji picker must not hide the conversation.
- Mobile browsers fire a synthesised mouse event after a touch, so the detector
  de-duplicates by pointer type and timestamp; one physical tap is one gesture.
- **A plain window blur never hides the chat.** Switching apps for a second and
  coming back must not lose the thread; only the 60-second hidden timer does.
- Locking also ends any active call, so a hidden screen is not still
  transmitting audio.

Hiding is cosmetic. Every API route authenticates and authorizes on its own,
so a locked screen protects nothing that the server was not already protecting.

The typing game is configured by `NEXT_PUBLIC_ENABLE_TYPING_GAME` (default
`true`). When disabled, the gate is bypassed: visitors land directly on
sign-in, and the access API routes reject unlock attempts with `403
TYPING_GAME_DISABLED`.

The **bootstrap secret code** comes from `SEED_SECRET_CODE` (`opensesame` by
default). On server start, `instrumentation.ts` seeds the access configuration
from it exactly once; afterwards an administrator rotates it from
`/admin/settings` (rotate strategy signs everyone out). The challenge endpoint
hands the code to the browser so keystrokes match locally — which means the
code is **public by design**: it gates the UI and nothing else, and every API
route authorises independently.

On boot, `lib/config/diagnostics.ts` runs a startup checklist over the
environment (placeholder secrets, localhost database in production, incomplete
S3 credentials, missing administrator, fallback providers in production) and
logs one machine-readable `config.issue` line per problem. Production builds
refuse `memory` providers outright (`assertFallbackAllowed`).

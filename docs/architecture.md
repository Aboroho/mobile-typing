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

**Realtime.** Mutations publish in-process on the realtime bus
(`lib/realtime/bus.ts`) and persist outbox events (`lib/realtime/outbox.ts`) to
the provider; the outbox worker re-publishes pending events so reconnecting
clients can resume from `?since=<eventId>`. SSE streams
(`/conversations/{id}/events`, `/calls/events`) are the primary realtime
channel (see `docs/api.md` for the event shapes); `server.ts` adds a
token-authenticated WebSocket endpoint at `/api/v1/ws` for bidirectional traffic
(e.g. typing indicators). Multi-instance deployments need a shared bus — the
documented upgrade is a single shared outbox poller driven by Postgres
`LISTEN`/`NOTIFY` or Redis Streams.

Money-quote for contributors: **validate → authenticate → service → provider →
respond**, realtime via bus + outbox, and no direct Prisma/DB access outside the
data providers.

## 5. Access gate and startup check

The public surface is the typing game. Before reconsidering this design, find
the code: unlock logic in `lib/access/*`, gate state in `stores/access.ts`,
lock triggers in `components/` (triple-tap) and `app/` (visibility change).

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

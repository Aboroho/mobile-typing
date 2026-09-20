# Keypad

A mobile-first, private 1:1 messaging web app that presents itself to every
visitor as a typing-practice game. The chat is reachable only by typing a
secret code into the game and then authenticating; it locks itself the moment
the tab is hidden or the user triple-taps.

Built as a **single Next.js app** (App Router) with TypeScript, Tailwind,
Zustand, Zod, Prisma/PostgreSQL and WebRTC audio calls. The same UI works on
phones and desktops. No external backend service is required: authentication is
email + password verified server-side (Argon2), sessions are database-backed,
and media goes to local disk or any S3-compatible store.

```
npm install && cp .env.example .env.local && npm run dev
```

Then open http://localhost:3000. Type the bootstrap secret code (`opensesame` by
default) into the typing test to reveal sign-in.

> New here? Read **[howto.md](./howto.md)** for `.env` setup, the PostgreSQL
> path, demo accounts, and troubleshooting the Start test button.

---

## Contents

- [Quick start](#quick-start)
- [Commands](#commands)
- [What is implemented](#what-is-implemented)
- [Repository layout](#repository-layout)
- [Environment variables](#environment-variables)
- [Administrator setup](#administrator-setup)
- [WebRTC / TURN](#webrtc--turn)
- [Documentation](#documentation)
- [Limitations](#limitations)

## Quick start

```bash
node --version          # >= 20.11
npm install
cp .env.example .env.local
npm run dev             # http://localhost:3000
```

Data and storage default to in-memory providers (`DATA_PROVIDER=memory`,
`STORAGE_PROVIDER=memory`), which are refused outright in a production build and
do not survive a restart. Everything — including sign-up, sign-in and chat —
works locally with zero external services.

For persistent data, point the app at PostgreSQL instead:

```bash
npx prisma migrate dev  # creates/updates the database from prisma/schema.prisma
```

and set `DATA_PROVIDER=prisma` (with `DATABASE_URL`) in `.env.local`. See
[howto.md](./howto.md) for the full walkthrough.

To create demo accounts against the configured provider:

```bash
npm run seed
```

The script registers an administrator account (`ADMIN_EMAIL` with the password
from `ADMIN_PASSWORD`) and a peer account through the real registration flow,
then prints the admin uid for `ADMIN_UID`. It refuses to run in production.

To review your environment files for common misconfigurations:

```bash
npm run doctor
```

It reports which file each value came from, flags placeholder/short secrets,
validates the Prisma `DATABASE_URL` and S3 credentials when those providers are
selected, and warns when no administrator is configured. Production deployment
(VPS, systemd, Nginx, backups) is covered in [`docs/deploy.md`](./docs/deploy.md).

## Commands

| Command                                   | Description                                                           |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                             | Start the Next.js dev server (port 3000)                              |
| `npm run build`                           | Production build                                                      |
| `npm run start`                           | Serve the production build                                            |
| `npm run serve`                           | Standalone server: Next.js + WebSocket + outbox worker in one process |
| `npm run worker`                          | Standalone outbox worker (for running it as its own process)          |
| `npm run typecheck`                       | `tsc --noEmit`                                                        |
| `npm run lint`                            | ESLint with `--max-warnings=0`                                        |
| `npm run lint:fix`                        | ESLint with autofix                                                   |
| `npm run format` / `npm run format:check` | Prettier                                                              |
| `npm run test`                            | Vitest: unit + API integration tests                                  |
| `npm run test:watch`                      | Vitest watch mode                                                     |
| `npm run test:coverage`                   | Vitest with V8 coverage                                               |
| `npm run e2e:install`                     | Download Chromium for Playwright (once)                               |
| `npm run e2e`                             | Playwright end-to-end tests (starts the dev server)                   |
| `npm run verify`                          | typecheck → test → build                                              |
| `npm run seed`                            | Register demo users through the real registration flow                |
| `npm run doctor`                          | Check env files, secrets, providers and credentials on this machine   |
| `npm run prisma:generate`                 | Regenerate the Prisma client                                          |
| `npm run prisma:migrate`                  | `prisma migrate dev` (local schema changes)                           |
| `npm run prisma:deploy`                   | `prisma migrate deploy` (production migrations)                       |

### Deploying

Single-server VPS deployment (PostgreSQL, Nginx, systemd/PM2, backups) is
documented step by step in [`docs/deploy.md`](./docs/deploy.md).

## What is implemented

**Access flow** — every visitor sees only the typing game. A secret code, matched
as a consecutive case-sensitive substring of a 15-character rolling keystroke
buffer, unlocks sign-in. The code is handed to the browser by the challenge
endpoint (matching happens locally), so it is treated as public: it grants no
data access, and every API route independently verifies the access session and
the user. The access session is bound to the user it was issued for.

**Typing game** — English and Bengali word lists (static assets under
`public/typing-words/`), 30/60/120 s tests, live WPM/accuracy/remaining
time, per-character highlighting, a result screen with a grade and replay, and a
layout that works on mobile and desktop (including virtual keyboards). If the
word list fails to load, a built-in fallback keeps **Start test** working.
Set `NEXT_PUBLIC_ENABLE_TYPING_GAME=false` to disable the game and the
secret-code gate entirely — visitors then land straight on sign-in and chat.

**Locking** — triple tap (touch + pointer, with time and distance thresholds) and
tab hide/minimise both return to the game and clear unlock state; an active call
is ended through the API first.

**Authentication** — email + password, verified server-side against an Argon2id
hash. Passwords travel in the POST body over TLS and are never logged; only the
hash is stored, and it never leaves the data layer. Sessions are opaque 256-bit
tokens kept hashed in the database and delivered as an httpOnly `mt_session`
cookie (non-browser clients may alternatively send `Authorization: Bearer
<token>`). Register, login, logout (with server-side session revocation) and
password re-authentication; opaque error messages that cannot enumerate
accounts; rate limiting. Password reset by email is **not** implemented — the UI
reports "not configured" rather than pretending to send mail.

**Conversations** — strictly 1:1 (a pair always resolves to the same
conversation), search, unread counts, presence, typing indicators, hide from list,
block.

**Messaging** — text, emoji and multiline messages with delivery/read/failed
states, reply-to, pagination, realtime updates over SSE (or WebSocket when
running `npm run serve`), optimistic UI with rollback and retry, length limits
and sanitisation. Edits are author-only within a server-enforced two-minute
window and keep full history. Deletion is soft: the content disappears for
users, is preserved for administrators, and can be scoped to "just me".

**Images** — capture or pick, client-side compression to 1600 px, progress and
cancel, MIME sniffing from magic bytes, size limits, secure storage paths, and
retrieval only through an authorised route.

**View-once photos** — an atomic single view (`sent → delivered → viewable →
viewing → viewed`), the sender is notified, administrators keep access, and the
overlay clears the image from the DOM on close.

**Voice messages** — MediaRecorder capture with a level meter, pre-send playback,
progress, and in-chat playback controls.

**Audio calls** — WebRTC 1:1 with ringing/active/missed/rejected/cancelled
states, mute, duration, ICE restart, TURN diagnostics, and history written into
the conversation. Signalling goes through the authenticated API only.

**Administration** — dashboard statistics, secret-code management with rotation
(signs everyone out) and an audit log that never shows the plaintext, user
search and disable, conversation inspection including deleted messages and edit
history, media inspection including view-once and deleted items, call history
and audit logs.

## Repository layout

```
app/                 Next.js App Router: UI pages + /api/v1/* route handlers
components/          React UI (typing game, chat, admin, shared primitives)
hooks/ stores/       Client hooks and Zustand stores
lib/
  types/             Domain types, enums and product limits
  validation/        Zod schemas for every request
  domain/            Pure business rules (keystroke buffer, scoring, policies)
  api-client/        Typed browser API client
  config/            Environment parsing (public + server) and diagnostics
  utils/             Hashing, ids, time, base64, text helpers
  access/ auth/ …    Server services, data providers, realtime, WebRTC
prisma/              PostgreSQL schema (prisma/schema.prisma) + migrations
public/typing-words/ English + Bengali word lists
scripts/             Dev seeding (seed-dev.ts) and env checker (doctor.mjs)
server.ts            Standalone server (Next.js + WebSocket + outbox worker)
proxy.ts             Security headers + CSP + request id (replaces middleware)
docs/                Architecture, API, schema, security, deployment, decisions
tests/               Vitest unit + API integration tests
e2e/                 Playwright specifications
howto.md             Setup, .env, and missing-data troubleshooting
```

This is a **single package** — no npm workspaces, no Turborepo, no separate
mobile app. Shared modules live under `lib/` and are imported via `@/` and
`@mt/*` path aliases.

## Environment variables

See [`.env.example`](./.env.example) and **[howto.md](./howto.md)** for the
annotated list and what happens when values are missing. The essentials:

| Variable                           | Purpose                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `DATA_PROVIDER`                    | `memory` for local work, `prisma` (PostgreSQL) in production          |
| `STORAGE_PROVIDER`                 | `memory` for local work, `local` (disk) or `s3` in production         |
| `DATABASE_URL`                     | PostgreSQL connection string (required for `prisma`)                  |
| `APP_SECRET`                       | Signs access challenges/sessions (≥ 16 characters, 32+ in production) |
| `ADMIN_UID` / `ADMIN_EMAIL`        | Administrator identity; never sent to a client                        |
| `SEED_SECRET_CODE`                 | Bootstrap code until an administrator changes it                      |
| `SESSION_DURATION_HOURS`           | Session lifetime (default 336 = two weeks)                            |
| `STUN_SERVER_URL`, `TURN_SERVER_*` | WebRTC ICE servers                                                    |

## Administrator setup

The administrator is whoever matches `ADMIN_UID` (canonical) or `ADMIN_EMAIL`
(convenience for development) — checked server-side on every admin request, so
there is no role to grant and nothing to deploy. `npm run seed` prints the uid
to put in `ADMIN_UID`. Administrators are **not** exempt from the typing-game
gate: the admin UI and API require an access session too.

## WebRTC / TURN

STUN alone is enough on a LAN; a TURN relay is required for clients behind
symmetric NATs, which is most mobile networks. ICE configuration is exposed only
through the authenticated `GET /api/v1/calls/ice-servers` route.

```
STUN_SERVER_URL=stun:stun.l.google.com:19302
TURN_SERVER_URL=turn:turn.example.com:3478
TURN_SERVER_USERNAME=webrtc
TURN_SERVER_CREDENTIAL=<secret>
```

## Documentation

| Document                                               | Contents                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`howto.md`](./howto.md)                               | **Start here** — install, `.env`, Postgres, demo accounts, troubleshooting |
| [`docs/architecture.md`](./docs/architecture.md)       | Setup, local development, layout, request lifecycle, access gate           |
| [`docs/api.md`](./docs/api.md)                         | Every route, auth requirement, payloads, error codes, SSE/WebSocket events |
| [`docs/database-schema.md`](./docs/database-schema.md) | PostgreSQL tables, relations, indexes, cursors                             |
| [`docs/security.md`](./docs/security.md)               | Threat model, defence in depth, credentials, cookies, headers              |
| [`docs/deploy.md`](./docs/deploy.md)                   | VPS deployment: Postgres, env reference, Nginx, backups, TURN              |
| [`docs/decisions.md`](./docs/decisions.md)             | Architectural decisions with rejected alternatives                         |
| [`docs/migration.md`](./docs/migration.md)             | Historical Firebase → PostgreSQL cutover runbook (one-time)                |

## Limitations

Stated plainly, because they shape how the app should be used:

- **The secret code is public.** The challenge endpoint hands it to the browser
  so keystrokes can be matched locally. It gates the UI and nothing else —
  every route re-authorises.
- **No end-to-end encryption.** The server can read every message. An attacker
  with database access can read everything.
- **Deletion is soft.** Messages, media and their original content are retained
  for administrative inspection.
- **Screenshots cannot be prevented.** View-once photos are claimed atomically,
  served once with `no-store`, and cleared from the DOM on close — but the OS
  screenshot shortcut, screen recording and a second camera all still work. The
  UI says so.
- **Realtime is best effort on multi-instance deployments.** SSE/WebSocket run
  over an in-process bus plus a database outbox; a shared outbox poller
  (Postgres `LISTEN`/`NOTIFY` or Redis Streams) is the documented upgrade path.
- **Very large uploads depend on deployment limits.** Oversized bodies are
  rejected with `413`; size the reverse proxy and `STORAGE_MAX_UPLOAD_BYTES`
  together (see [`docs/deploy.md`](./docs/deploy.md)).

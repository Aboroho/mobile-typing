# Keypad

A mobile-first, private 1:1 messaging web app that presents itself to every
visitor as a typing-practice game. The chat is reachable only by typing a
secret code into the game and then authenticating; it locks itself the moment
the tab is hidden or the user triple-taps.

Built with Next.js (App Router), TypeScript, Tailwind, Zustand, Zod and Firebase
(Auth, Firestore, Storage, Admin SDK), with WebRTC audio calls.

```
npm install && cp .env.example .env.local && npm run dev
```

Then open http://localhost:3000. Type the bootstrap secret code (`opensesame` by
default) into the typing test to reveal sign-in.

---

## Contents

- [Quick start](#quick-start)
- [Commands](#commands)
- [What is implemented](#what-is-implemented)
- [Repository layout](#repository-layout)
- [Environment variables](#environment-variables)
- [Firebase and administrator setup](#firebase-and-administrator-setup)
- [WebRTC / TURN](#webrtc--turn)
- [Documentation](#documentation)
- [Limitations](#limitations)

## Quick start

```bash
node --version          # >= 20.11
npm install             # installs all workspaces
cp .env.example .env.local
npm run dev             # http://localhost:3000
```

No Firebase project is required for local development: the default providers are
in-memory (`DATA_PROVIDER=memory`, `AUTH_PROVIDER=dev`, `STORAGE_PROVIDER=memory`)
and are refused outright in a production build. State does not survive a restart.

To create demo accounts against a running dev server:

```bash
npm run seed
```

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js dev server (port 3000) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` across every workspace |
| `npm run lint` | ESLint with `--max-warnings=0` |
| `npm run lint:fix` | ESLint with autofix |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run test` | Vitest: unit + API integration tests |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Vitest with V8 coverage |
| `npm run e2e:install` | Download Chromium for Playwright (once) |
| `npm run e2e` | Playwright end-to-end tests (starts the dev server) |
| `npm run verify` | typecheck → lint → test → build |
| `npm run seed` | Register demo users through the public API |
| `npm run firebase:deploy:rules` | Deploy Firestore/Storage rules and indexes |

### Deploying

```bash
npm run build           # or: vercel deploy --prod
firebase deploy --only firestore:rules,storage.rules,firestore:indexes
```

Full Vercel instructions, including the 4.5 MB body-size constraint, are in
[`docs/deployment.md`](./docs/deployment.md).

## What is implemented

**Access flow** — every visitor sees only the typing game. A secret code, matched
as a consecutive case-sensitive substring of a 15-character rolling keystroke
buffer, unlocks sign-in. The code is never displayed, never logged, and grants no
data access: every API route independently verifies the access session and the
user, and the access session is bound to the user it was issued for.

**Typing game** — English and Bengali word lists (static assets under
`apps/web/public/typing-words/`), 30/60/120 s tests, live WPM/accuracy/remaining
time, per-character highlighting, a result screen with a grade and replay, and a
layout that works with a virtual keyboard.

**Locking** — triple tap (touch + pointer, with time and distance thresholds) and
tab hide/minimise both return to the game and clear unlock state; an active call
is ended through the API first.

**Authentication** — Firebase email/password or a development provider with
scrypt-hashed passwords; register, login, logout, reauthentication and password
reset; opaque error messages that cannot enumerate accounts; rate limiting.

**Conversations** — strictly 1:1 (a pair always resolves to the same
conversation), search, unread counts, presence, typing indicators, hide from list,
block.

**Messaging** — text, emoji and multiline messages with delivery/read/failed
states, reply-to, pagination, realtime updates over SSE, optimistic UI with
rollback and retry, length limits and sanitisation. Edits are author-only within a
server-enforced two-minute window and keep full history. Deletion is soft: the
content disappears for users, is preserved for administrators, and can be scoped
to "just me".

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
(signs everyone out) and an audit log that never shows the plaintext, user search
and disable, conversation inspection including deleted messages and edit history,
media inspection including view-once and deleted items, call history and audit
logs.

## Repository layout

```
apps/web                Next.js application: UI, 51 API routes, services
apps/mobile/README.md   Notes for a future React Native client
packages/types          Domain types, enums and product limits
packages/validation     Zod schemas for every request
packages/domain         Pure business rules (keystroke buffer, scoring, policies)
packages/api-client     Typed browser API client
packages/config         Environment parsing (public + server)
packages/utils          Hashing, ids, time, base64, text helpers
firebase/               Firestore/Storage rules, indexes, provisioning notes
scripts/                Dev seeding, admin custom-claim helper
docs/                   Architecture, API, schema, security, deployment, decisions
e2e/                    Playwright specifications
```

## Environment variables

See [`.env.example`](./.env.example) for the annotated list. The essentials:

| Variable | Purpose |
| --- | --- |
| `DATA_PROVIDER` / `AUTH_PROVIDER` / `STORAGE_PROVIDER` | `memory`/`dev` for local work, `firebase` in production |
| `APP_SECRET` | Signs access challenges and sessions (≥ 16 characters) |
| `ADMIN_UID` / `ADMIN_EMAIL` | Administrator identity; never sent to a client |
| `SEED_SECRET_CODE` | Bootstrap code until an administrator changes it |
| `NEXT_PUBLIC_FIREBASE_*` | Firebase web config (public by design) |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Admin SDK credentials |
| `STUN_SERVER_URL`, `TURN_SERVER_*` | WebRTC ICE servers |

## Firebase and administrator setup

```bash
firebase projects:create <project-id>
firebase use <project-id>
firebase deploy --only firestore:rules,storage.rules,firestore:indexes
ADMIN_UID=<uid> node scripts/set-admin-claim.mjs
```

Step-by-step instructions — including Authentication, Firestore, Storage and the
Vercel deployment — are in [`docs/deployment.md`](./docs/deployment.md).

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

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | Setup, local development, workspace layout, request lifecycle, the access gate and secret-code behaviour, locking, session invalidation |
| [`docs/api.md`](./docs/api.md) | Every route, its auth requirement, payloads, error codes, rate limits and SSE events |
| [`docs/database-schema.md`](./docs/database-schema.md) | Collections, fields, indexes, cursors and known Firestore limitations |
| [`docs/security.md`](./docs/security.md) | Threat model, defence in depth, credentials, cookies, headers, privacy limitations, screenshot limitations, production checklist |
| [`docs/deployment.md`](./docs/deployment.md) | Environment variables, Firebase provisioning, TURN, Vercel, troubleshooting |
| [`docs/decisions.md`](./docs/decisions.md) | Architectural decisions with the rejected alternatives |

## Limitations

Stated plainly, because they shape how the app should be used:

- **The secret code is public.** The browser has to match it locally, so it is in
  the bundle. It gates the UI and nothing else — every route re-authorises.
- **No end-to-end encryption.** The server can read every message. An attacker
  with Admin credentials or database access can read everything.
- **Deletion is soft.** Messages, media and their original content are retained
  for administrative inspection.
- **Screenshots cannot be prevented.** View-once photos are claimed atomically,
  served once with `no-store`, and cleared from the DOM on close — but the OS
  screenshot shortcut, screen recording and a second camera all still work. The
  UI says so.
- **Realtime is best effort on multi-instance deployments.** SSE runs over an
  in-process bus; Firestore change feeds are the documented upgrade path.
- **Vercel caps request bodies at 4.5 MB.** Images are compressed well below
  that; very long voice messages may exceed it and are rejected with `413`.

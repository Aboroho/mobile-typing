# Keypad

A mobile-first, private 1:1 messaging web app that presents itself to every
visitor as a typing-practice game. The chat is reachable only by typing a
secret code into the game and then authenticating; it locks itself the moment
the tab is hidden or the user triple-taps.

Built as a **single Next.js app** (App Router) with TypeScript, Tailwind,
Zustand, Zod and Firebase (Auth, Firestore, Storage, Admin SDK), plus WebRTC
audio calls. The same UI works on phones and desktops.

```
npm install && cp .env.example .env.local && npm run dev
```

Then open http://localhost:3000. Type the bootstrap secret code (`opensesame` by
default) into the typing test to reveal sign-in.

> New here? Read **[howto.md](./howto.md)** for `.env` setup, what happens when
> data is missing, and troubleshooting the Start test button.

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
npm install
cp .env.example .env.local
npm run dev             # http://localhost:3000
```

Data and storage default to in-memory providers (`DATA_PROVIDER=memory`,
`STORAGE_PROVIDER=memory`), which are refused outright in a production build and
do not survive a restart.

**Authentication always uses Firebase.** There is no development password
provider or silent fallback: the browser signs users up and
in with the Firebase client SDK, and the API verifies the resulting ID tokens
with the Admin SDK. Fill in the `NEXT_PUBLIC_FIREBASE_*` (web) and
`FIREBASE_*` (service account) blocks of `.env.local`, and enable
Authentication → Sign-in method → Email/Password in the console. `npm run doctor`
checks the whole setup, including that the Email/Password provider is enabled.
For isolated local tests without a live project, use the explicit Auth emulator
setup in **[docs/auth-testing.md](./docs/auth-testing.md)**.

To create demo accounts against a running dev server:

```bash
npm run seed
```

The script signs up through the Identity Toolkit REST API
(`NEXT_PUBLIC_FIREBASE_API_KEY`) and registers with the resulting Firebase ID
token, exactly like the browser does.

### Keeping everything in Firebase

Set `DATA_PROVIDER=firestore` and `STORAGE_PROVIDER=firebase` plus the web and
Admin credentials, then verify the result before relying on it:

```bash
npm run doctor
```

It reports which file each value came from, initialises the Admin SDK, writes and
deletes a probe document, checks that the conversation-list index exists, signs a
throwaway user up through the same Identity Toolkit call the browser makes, and
uploads and deletes a probe object — so a missing Firestore database, a disabled
Email/Password provider or an absent bucket is named instead of surfacing later as
a 401 or a 500. `.env.local` takes precedence over `.env`, and a key set to an
empty value still counts as set, so a copied template silently hides real
credentials in the other file; that shadowing is the first thing the doctor
reports. Console steps it cannot do for you are in
[`firebase/README.md`](./firebase/README.md) and
[`docs/deployment.md`](./docs/deployment.md).

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js dev server (port 3000) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with `--max-warnings=0` |
| `npm run lint:fix` | ESLint with autofix |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run test` | Vitest: unit + API integration tests |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Vitest with V8 coverage |
| `npm run e2e:install` | Download Chromium for Playwright (once) |
| `npm run e2e` | Playwright game/access-gate tests (starts the dev server) |
| `npm run e2e:auth` | Mobile + desktop signup, reload, logout, rejected password and login against an isolated Firebase Auth emulator; stop the dev server first |
| `npm run verify` | typecheck → lint → test → build |
| `npm run seed` | Register demo users through Firebase and the public API |
| `npm run doctor` | Check that this machine can really use the configured Firebase project (env precedence, credentials, Firestore, Auth, Storage) |
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
`public/typing-words/`), 30/60/120 s tests, live WPM/accuracy/remaining
time, per-character highlighting, a result screen with a grade and replay, and a
layout that works on mobile and desktop (including virtual keyboards). If the
word list fails to load, a built-in fallback keeps **Start test** working.
Set `NEXT_PUBLIC_ENABLE_TYPING_GAME=false` to disable the game and the
secret-code gate entirely — visitors then land straight on sign-in and chat.

**Locking** — triple tap (touch + pointer, with time and distance thresholds) and
tab hide/minimise both return to the game and clear unlock state; an active call
is ended through the API first.

**Authentication** — Firebase Authentication (email/password) only. The browser
SDK verifies the password and holds the ID token; the API verifies that token
server-side, initialises the profile and mints an httpOnly Firebase session
cookie (which is what the SSE streams authenticate with). Register, login,
logout (with server-side credential revocation), reauthentication and password
reset; opaque error messages that cannot enumerate accounts; rate limiting. No
password or password hash is ever stored in this application's database.

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
app/                 Next.js App Router: UI pages + /api/v1/* route handlers
components/          React UI (typing game, chat, admin, shared primitives)
hooks/ stores/       Client hooks and Zustand stores
lib/
  types/             Domain types, enums and product limits
  validation/        Zod schemas for every request
  domain/            Pure business rules (keystroke buffer, scoring, policies)
  api-client/        Typed browser API client
  config/            Environment parsing (public + server)
  utils/             Hashing, ids, time, base64, text helpers
  access/ auth/ …    Server services, data providers, realtime, WebRTC
public/typing-words/ English + Bengali word lists
firebase/            Firestore/Storage rules, indexes, provisioning notes
scripts/             Dev seeding, admin custom-claim helper
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

| Variable | Purpose |
| --- | --- |
| `DATA_PROVIDER` / `STORAGE_PROVIDER` | `memory` for local work, `firestore`/`firebase` in production |
| `APP_SECRET` | Signs access challenges and sessions (≥ 16 characters) |
| `ADMIN_UID` / `ADMIN_EMAIL` | Administrator identity; never sent to a client |
| `SEED_SECRET_CODE` | Bootstrap code until an administrator changes it |
| `NEXT_PUBLIC_FIREBASE_*` | Firebase web config (public by design) |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Admin SDK credentials |
| `FIREBASE_AUTH_EMULATOR_HOST` | Explicit local Auth emulator, e.g. `127.0.0.1:9199`; no URL scheme, forbidden in production |
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
| [`howto.md`](./howto.md) | **Start here** — install, `.env`, missing data, Start button |
| [`docs/architecture.md`](./docs/architecture.md) | Setup, local development, layout, request lifecycle, access gate |
| [`docs/api.md`](./docs/api.md) | Every route, auth requirement, payloads, error codes, SSE events |
| [`docs/database-schema.md`](./docs/database-schema.md) | Collections, fields, indexes, cursors |
| [`docs/security.md`](./docs/security.md) | Threat model, defence in depth, credentials, cookies, headers |
| [`docs/deployment.md`](./docs/deployment.md) | Environment variables, Firebase, TURN, Vercel, troubleshooting |
| [`docs/decisions.md`](./docs/decisions.md) | Architectural decisions with rejected alternatives |

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

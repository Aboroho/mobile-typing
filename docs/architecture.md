# Architecture

Keypad is a mobile-first, private 1:1 messaging web app that presents itself to
every visitor as a typing-practice game. This document covers project setup,
local development and the behaviour of the secret-code gate. Environment
variables, Firebase provisioning, TURN configuration and Vercel deployment live
in [`deployment.md`](./deployment.md); the threat model lives in
[`security.md`](./security.md).

## 1. Project setup

```bash
node --version        # >= 20.11 required
npm install           # single Next.js app at the repository root
cp .env.example .env.local
npm run dev           # http://localhost:3000
```

`npm install` is the only setup step. There is no code generation, no database
migration and no external service required to run locally: the default providers
are in-memory and are selected by `DATA_PROVIDER=memory`
and `STORAGE_PROVIDER=memory`.

## 2. Local development

| Command | What it runs |
| --- | --- |
| `npm run dev` | Next.js dev server on port 3000 |
| `npm run build` | Production build (`next build`) |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config, `--max-warnings=0`) |
| `npm run test` | Vitest unit + API integration tests |
| `npm run e2e` | Playwright (requires `npm run e2e:install` once) |
| `npm run verify` | typecheck → lint → test → build |
| `npm run seed` | Registers demo users against a running dev server |

With the memory provider, all state lives in `globalThis.__mt_memory_store_v1`
and is lost on restart. That is deliberate: nothing about the development
fallback can be confused with production data, and `assertFallbackAllowed()`
throws if a fallback provider is ever reached in a production build.

## 3. Application layout

Single Next.js package at the repository root (no monorepo / workspaces):

```
app/                  Next.js App Router (UI + API routes)
components/           React UI
hooks/ stores/        Client hooks and Zustand stores
lib/types             Domain types, enums and product limits
lib/validation        Zod schemas for every request body and query string
lib/domain            Pure business rules (no React, no Firebase, no HTTP)
lib/api-client        Typed HTTP client used by the browser
lib/config            Environment parsing for public and server contexts
lib/utils             Hashing, ids, time, base64 and text helpers
lib/*                 Server services, data providers, auth, realtime, …
public/               Static assets including typing word lists
firebase/             Firestore/Storage rules, composite indexes, notes
scripts/              Dev seeding and admin-claim helpers
tests/ e2e/           Vitest + Playwright
docs/                 This directory
howto.md              Setup, .env, missing-data troubleshooting
```

Dependency direction is one-way: app/components → `lib/*` → `lib/types`.
`lib/domain` is where every rule that matters is implemented once — the
rolling keystroke buffer, typing scoring, the message edit window, the
soft-delete patch, the view-once state machine, media validation and call
transitions — so the API layer and the UI cannot drift apart.

Inside the app:

```
app/                  Routes and API handlers (51 route files under app/api/v1)
components/           React components, grouped by feature
hooks/                useTypingGame, useKeystrokeUnlock, useTripleTap, …
lib/api/              routeHandler, JSON envelope helpers
lib/auth/             Providers, cookie handling, guards
lib/access/           Secret-code challenges and access sessions
lib/browser/          Keystroke detection, triple tap, image compression, recorder
lib/client/           Browser-side API client and auth bootstrap
lib/data/             Repository interfaces + memory and Firestore providers
lib/firebase/         Admin SDK initialisation and document (de)serialisation
lib/realtime/         In-process event bus and SSE helpers
lib/security/         Rate limiting and audit logging
lib/services/         Application services (the actual use cases)
lib/storage/          Memory and Firebase Storage adapters
lib/webrtc/           CallManager (RTCPeerConnection wrapper)
stores/               Zustand stores (access, auth, chat, call, ui)
tests/                API integration tests that call route handlers directly
```

## 4. Request lifecycle

1. **`proxy.ts`** (Next 16's replacement for `middleware.ts`) adds security
   headers, including the Content-Security-Policy, and a request id. It performs
   **no** authorisation.
2. **Route handler** in `app/api/v1/**/route.ts`, wrapped in `routeHandler()`,
   which converts thrown `AppError`s into the standard error envelope and logs a
   single structured line per request.
3. **Guard**: `requireAccess` (valid access session), `requireUser` (verified
   Firebase ID token or dev session cookie), `requireAuthenticatedAccess` (both)
   or `requireAdminAccess` (both plus the configured administrator identity).
4. **Validation**: `parseWith(schema, body)` with a Zod schema from
   `@mt/validation`. A failed parse is a `422 VALIDATION_ERROR` with per-field
   details and never reaches a service.
5. **Service** in `lib/services/*` implements the use case using repository
   interfaces from `lib/data/types.ts`.
6. **Response**: `{ ok: true, data }` or `{ ok: false, error: { code, message,
   details? } }`.

Realtime updates are pushed over SSE (`/conversations/[id]/events`,
`/calls/events`) from an in-process bus; the browser subscribes with
`EventSource`. Firestore change feeds are the documented upgrade path
(`docs/decisions.md`).

## 5. The access gate (first visit)

Every visitor — including administrators — starts at the typing game. Nothing
about the messaging app is loaded, routed or hinted at until three independent
conditions hold:

1. The browser holds a valid **access session** cookie (`mt_access`).
2. The caller is **authenticated** (`mt_session` cookie in dev, Firebase ID token
   in production).
3. The access session was **bound to that user** — a session minted before login
   cannot be reused after authenticating as somebody else.

Sequence:

```
Browser                                   Server
  │  POST /api/v1/access/challenge          │
  ├────────────────────────────────────────▶│  issues a signed challenge token
  │◀────────────────────────────────────────┤  (10 min) + the current code
  │  user types into the game               │
  │  local rolling buffer matches the code  │
  │  POST /api/v1/access/unlock             │
  │    { challengeToken, digest: sha256 }   │
  ├────────────────────────────────────────▶│  verifies token, epoch, digest
  │◀────────────────────────────────────────┤  sets mt_access (30 min, httpOnly)
  │  POST /api/v1/auth/login                │
  ├────────────────────────────────────────▶│  verifies credentials
  │◀────────────────────────────────────────┤  re-issues mt_access bound to uid
```

### 5.1 Secret-code behaviour

- **Where it lives**: `appConfig/access` in Firestore (`code`, `digest`, `salt`,
  `epoch`, `maxLength`, `caseSensitive`, `unlockCount`, timestamps). Only the
  Admin SDK can read it; `firebase/firestore.rules` denies all client access.
- **Matching**: the browser keeps a rolling buffer of at most
  `SECRET_CODE_MAX_LENGTH` (15) characters and matches the code as a
  **consecutive, case-sensitive substring**. `openXsesame` does not match
  `opensesame`; `OpenSesame` does not match `opensesame`. Matching fires at most
  once per buffer and the buffer is cleared immediately afterwards.
- **Input sources**: `keydown` for physical keyboards *and* `beforeinput`
  (`inputType === 'insertText'`) because mobile virtual keyboards report
  `key === 'Unidentified'`. A 120 ms duplicate window prevents a key from being
  counted twice. Only single printable characters are accepted, so paste, IME
  composition and modifier keys cannot poison the buffer.
- **What is ignored**: credential and identity fields (`input[type=password]`,
  `input[type=email]`, `input[name=email]`, `autocomplete=username|*-password`,
  and anything marked `data-secret-ignore="true"`), so a password can never
  accidentally unlock the app — and the game's own input still feeds the buffer.
- **Never displayed**: the code is not rendered anywhere, not logged, and the
  admin panel shows only whether a code is configured, its length, its epoch and
  a fingerprint of its salted digest.
- **Not an authorisation decision**: the challenge response deliberately carries
  the plaintext code, because the match happens in the browser. Anyone reading
  the bundle can find it. Every API route independently enforces
  `requireAccess` + `requireUser`, so knowing the code reveals no data at all —
  it only decides which UI is shown. This trade-off is required by the product
  design and is restated in `docs/security.md`.
- **Rotation**: an administrator changes the code in `/admin/settings`. The
  default `rotate` strategy bumps `epoch`, which instantly invalidates every
  outstanding challenge token and access session (each is signed with the epoch
  it was issued under). `replace` keeps sessions alive. The rotation is covered
  by an integration test that asserts a previously unlocked browser is locked
  out immediately.

### 5.2 Locking

The app returns to the typing game and clears unlock state when:

- the user **triple-taps** (three taps within 600 ms, each within 40 px of the
  previous one, detected from both `touchstart` and `pointerdown`);
- the tab is **hidden or minimised** (`visibilitychange`, plus `pagehide` and
  `blur` as fallbacks);
- the access session **expires** (30 min) or is revoked by a rotation — the API
  client dispatches `mt:access-required`, which the provider turns into a lock;
- the user chooses **Lock now** or **Sign out** in Settings.

Locking during a call ends the call through `POST /api/v1/calls/{id}/end` first,
so no call record is left ringing.

### 5.3 Session invalidation strategy

| Event | Effect |
| --- | --- |
| Access session TTL (30 min) | Browser returns to the game on the next request |
| Secret-code rotation (`rotate`) | Every challenge and access session is invalid immediately (epoch mismatch) |
| Sign out | `mt_session` cleared; access session revoked via `/access/lock` |
| Account disabled | `resolveAuth` rejects the token on every request |
| Password change | Firebase ID tokens keep their normal lifetime; `authTime` is re-checked for reauthentication |

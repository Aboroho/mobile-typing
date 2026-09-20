# How to set up Keypad

This is a **single Next.js app** (no monorepo). One install, one `npm run dev`,
and the same UI works on phones and desktops.

---

## 1. Prerequisites

- **Node.js 20.11+** (`node --version`)
- npm 10+ (ships with Node)
- Optional: PostgreSQL 15+ if you want persistent data via the Prisma provider
  (section 4). Without it, everything runs in memory.

---

## 2. Install and run (local, in-memory)

```bash
# from the repository root
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

You should see the **Keypad** typing-practice screen. Click **Start test** —
the game must begin even if nothing else is configured.

Default local providers (safe for development only):

| Variable           | Default       | Meaning                                                    |
| ------------------ | ------------- | ---------------------------------------------------------- |
| `DATA_PROVIDER`    | `memory`      | In-process store; wiped on restart                         |
| `STORAGE_PROVIDER` | `memory`      | In-process media blobs; wiped on restart                   |
| `SEED_SECRET_CODE` | `opensesame`  | Type this into the game to reveal sign-in                  |
| `APP_SECRET`       | (dev default) | Signs access sessions — set a real one for anything shared |

### Trying it from a phone on the same network

`npm run dev` listens on `0.0.0.0`, so open `http://<your-lan-ip>:3000` on the
phone (both devices on the same Wi-Fi). Local network addresses
(`192.168.*.*`, `10.*.*.*`, `172.*.*.*`, `169.254.*.*`) and mDNS names
(`laptop.local`) are accepted by the dev server out of the box — Next.js
otherwise blocks its HMR/development endpoints for an unknown host, and a
blocked HMR connection means **the page renders but never becomes
interactive**: buttons do nothing and the secret code can never be typed in.
Reaching the dev server through a proxy or a public name? Add that hostname:

```bash
ALLOWED_DEV_ORIGINS=dev.example.com npm run dev
```

A plain `http://192.168.x.x:3000` origin is not a _secure context_, so browser
APIs such as `crypto.subtle` and `getUserMedia` are unavailable there. The app
covers the unlock (SHA-256 falls back to a bundled implementation), but voice
messages and audio calls need `https` or `localhost`.

These defaults are **refused in a production build**. No external service is
needed for anything: sign-up, sign-in and chat all run against the dev server
itself (passwords verified server-side with Argon2).

### Demo accounts

With the configured provider available (nothing extra to run for `memory`):

```bash
npm run seed
```

This registers the administrator account (`ADMIN_EMAIL` with the password from
`ADMIN_PASSWORD` — both read from `.env.local` / the environment) and a peer
account through the real registration flow, creates a conversation between them,
and prints the admin uid for `ADMIN_UID`. The secret code typed to unlock the
gate comes from `SEED_SECRET_CODE`. The script refuses to run when
`ADMIN_EMAIL` or `ADMIN_PASSWORD` is unset, and refuses to run in production.

Re-running the seed is safe: registering an existing email re-issues a session
instead of failing, and `ADMIN_UID` is printed either way.

---

## 3. The `.env` file

Copy the example, then edit:

```bash
cp .env.example .env.local
```

Next.js loads `.env.local` automatically. **Never commit** `.env`, `.env.local`,
or real secrets. Anything prefixed with `NEXT_PUBLIC_` is shipped to the browser
and is public by design.

> **Precedence trap.** Next.js reads `.env.local` _before_ `.env`, and a key set
> to an empty value still counts as set. So a copied template with blank lines
> silently hides the real values in `.env`. Keep the values in **one** file —
> `.env.local` — or delete the blank lines from it. `npm run doctor` prints the
> file each value came from and names every shadowed key.

### Minimum for local development

```env
APP_ENV=development
DATA_PROVIDER=memory
STORAGE_PROVIDER=memory
APP_SECRET=<openssl rand -hex 32>
SEED_SECRET_CODE=opensesame
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe123!
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=Keypad
```

With that in place the typing game, sign-up, sign-in and the chat all work
locally against in-memory data.

Generate strong secrets with:

```bash
openssl rand -hex 32
```

### Full variable reference

See [`.env.example`](./.env.example) for every key with comments. Summary:

| Group             | Variables                                                                      | Required when                                                 |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| App               | `APP_ENV`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_WS_URL` | Always                                                        |
| Providers         | `DATA_PROVIDER`, `STORAGE_PROVIDER`                                            | Always                                                        |
| Postgres          | `DATABASE_URL`                                                                 | `DATA_PROVIDER=prisma`                                        |
| Secrets           | `APP_SECRET`                                                                   | Always (≥ 16 chars; signs access sessions, not auth sessions) |
| Sessions          | `SESSION_DURATION_HOURS`                                                       | Optional (default 336 = two weeks)                            |
| Access            | `SEED_SECRET_CODE`, `SECRET_CODE_MAX_LENGTH`                                   | Local bootstrap                                               |
| Admin             | `ADMIN_UID` or `ADMIN_EMAIL`                                                   | Admin UI                                                      |
| Object storage    | `STORAGE_*`                                                                    | `STORAGE_PROVIDER=s3` / `local`                               |
| WebRTC            | `STUN_SERVER_URL`, `TURN_SERVER_*`                                             | Audio calls off-LAN                                           |
| Limits / security | `RATE_LIMIT_*`, `CSP_MODE`, `LOG_LEVEL`                                        | Optional tuning                                               |

---

## 4. Persistent data with PostgreSQL

```bash
# 1. Create the database (example: local Postgres)
createdb mobile_typing

# 2. Point the app at it in .env.local
DATA_PROVIDER=prisma
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mobile_typing?schema=public

# 3. Apply the schema and generate the client
npx prisma migrate dev
npm run prisma:generate

# 4. Run
npm run dev
```

The schema lives in `prisma/schema.prisma` and is documented table by table in
[`docs/database-schema.md`](./docs/database-schema.md). In production apply
migrations with `npm run prisma:deploy` (`prisma migrate deploy`) instead —
see [`docs/deploy.md`](./docs/deploy.md).

For persistent media alongside Postgres, use `STORAGE_PROVIDER=local`
(`STORAGE_LOCAL_DIR`, single server) or `STORAGE_PROVIDER=s3` (any
S3-compatible store; needs the `@aws-sdk/*` packages installed).

---

## 5. What if data / config is missing?

The app is designed to **degrade safely** instead of crashing the public UI.

| Missing piece                                                                             | What you see / what happens                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `.env.local` at all                                                                    | Dev defaults from `lib/config/server-env.ts` apply. Game and memory providers still work.                                                                                                                                                                                                                        |
| Blank optional keys (`ADMIN_UID=`, empty `TURN_*`)                                        | Treated as unset. Safe to copy `.env.example` as-is.                                                                                                                                                                                                                                                             |
| Empty / invalid `APP_SECRET`                                                              | Server env parse fails on boot / first API call. Set ≥ 16 characters.                                                                                                                                                                                                                                            |
| Word list file missing (`public/typing-words/*.txt`)                                      | Start test still works — a built-in English/Bengali fallback list is used and a small warning is shown.                                                                                                                                                                                                          |
| `DATA_PROVIDER=prisma` but Postgres is unreachable                                        | Server routes that touch the database throw a clear error. Check `DATABASE_URL`, then run `npx prisma migrate dev`. Switch back to `memory` to iterate without a database.                                                                                                                                       |
| `STORAGE_PROVIDER=s3` without credentials                                                 | Media writes fail with a 500 naming the missing keys (`STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`). Use `memory` locally.                                                                                                                                                                       |
| `npm run seed` fails with 429 `RATE_LIMITED`                                              | Registration is limited to 5 calls / 10 min / IP (`auth:register`). Wait for the window, or restart the dev server to reset the in-memory counters.                                                                                                                                                              |
| `npm run seed` refuses to run                                                             | `ADMIN_EMAIL` or `ADMIN_PASSWORD` is unset, or `NODE_ENV=production`.                                                                                                                                                                                                                                            |
| Login fails with `unable to sign in with those details`                                   | Wrong password, unknown email and disabled account all read the same on purpose (no account enumeration). Check the server log for the specific `auth.login_*` line.                                                                                                                                             |
| No `ADMIN_UID` / `ADMIN_EMAIL`                                                            | Admin routes return forbidden; the rest of the app is fine. Run `npm run seed` then set `ADMIN_UID`.                                                                                                                                                                                                             |
| No TURN server                                                                            | Calls may work on the same LAN via STUN; mobile networks usually need TURN.                                                                                                                                                                                                                                      |
| Phone on the Wi-Fi: page loads, but nothing is clickable and the secret code does nothing | The dev server refused the HMR request from that host (`⚠ Blocked cross-origin request to Next.js dev resource`), so the page never hydrated. Local network addresses and `**.local` names are allowed by default in `next.config.ts`; add others with `ALLOWED_DEV_ORIGINS=my-host` and restart `npm run dev`. |
| Page stuck on "Loading words…"; console repeats `WebSocket connection to 'ws://…:3000/_next/hmr?id=…' failed: Connection closed before receiving a handshake response` (plus a `Cross-Origin-Opener-Policy … origin was untrustworthy` notice on a LAN address); nothing in the server log | Next's dev HMR socket was being closed by our own `upgrade` handler before Next could answer it, so the client kept reconnecting and force-reloading the page instead of hydrating. `server.ts` now only claims `/api/v1/ws` and leaves `/_next/*` to Next (`lib/ws/upgrade.ts`). Pull the fix and restart `npm run dev`; the COOP notice is harmless and is no longer emitted for plain-`http` LAN origins in development. |
| `403 /api/v1/calls/events` repeating in the dev log                                       | A browser is signed in (`mt_session`, two weeks) but has no access session (`mt_access`, thirty minutes). The client waits for the unlock before opening user-scoped streams; reload the page and enter the code to clear an old tab that was opened before this fix.                                            |
| Fresh database, no secret code configured                                                 | The access config is bootstrapped from `SEED_SECRET_CODE` on first boot (`instrumentation.ts`).                                                                                                                                                                                                                  |
| Production build with `memory` providers                                                  | **Hard fail** — `assertFallbackAllowed` refuses so you cannot ship insecure defaults.                                                                                                                                                                                                                            |
| Forgot password?                                                                          | Password reset by email is not implemented: the UI reports "not configured". Reset the password out of band (e.g. update the user row) until a mail transport is wired up.                                                                                                                                       |

### Quick health check

```bash
curl -s http://localhost:3000/api/v1/health | jq
```

You should see `dataProvider`, `authProvider: "argon2-session"`, and
`ok: true`. If this fails, the server did not start or env parsing threw —
check the terminal running `npm run dev`.

### Read the boot log first

On every start the server reviews the environment (`lib/config/diagnostics.ts`)
and logs one `config.issue` line per problem it can predict — placeholder
secrets, a localhost database in production, incomplete S3 credentials, a
missing administrator, or a fallback provider in a production build. Each line's
`message` field names the exact variables to change, which is usually faster
than decoding the first failing request:

```json
{
  "level": "warn",
  "message": "config.issue",
  "fields": {
    "reason": "admin_not_configured",
    "message": "Neither ADMIN_UID nor ADMIN_EMAIL is set: no user will have administrator access."
  }
}
```

Known reasons: `placeholder_secret`, `weak_secret`,
`database_localhost_in_production`, `s3_storage_incomplete`,
`admin_not_configured`, `fallback_provider_in_production`.

### Typing game still won't start?

1. Hard-refresh the browser (cache can serve a stale bundle).
2. Confirm `public/typing-words/en.txt` exists (optional thanks to the fallback).
3. Open DevTools → Console for client errors; Network for `/typing-words/en.txt`.
4. Ensure you are on `/` (or `/typing-game`) and the page title is “Keypad”.

---

## 6. Running in production

Production means PostgreSQL + `local`/`s3` storage on a server you control
(VPS guide in [`docs/deploy.md`](./docs/deploy.md)):

```bash
DATA_PROVIDER=prisma
STORAGE_PROVIDER=local   # or s3
APP_ENV=production NODE_ENV=production
```

`APP_ENV=production` together with `NODE_ENV=production` refuses the memory
data and storage providers outright, which is what you want on a server and not
what you want while iterating locally.

```bash
npm run doctor            # check env, secrets and provider credentials first
npm run prisma:deploy     # apply migrations
npm run build && npm run serve   # Next.js + WebSocket + outbox worker
```

Then sign in as the `ADMIN_EMAIL` account and change the secret code in
`/admin/settings` with the `rotate` strategy.

---

## 7. Useful commands

| Command                                    | Purpose                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| `npm run dev`                              | Dev server on `0.0.0.0:3000` (Next.js + WebSocket + outbox worker) |
| `npm run dev:next`                         | Plain Next.js dev server (no WebSocket; SSE fallback)   |
| `npm run build` / `npm start`              | Production build + serve (Next.js + WebSocket + outbox worker) |
| `npm run serve`                            | Standalone server (Next.js + WebSocket + outbox worker) |
| `npm run worker`                           | Outbox worker as its own process                        |
| `npm run test`                             | Unit + API tests (Vitest, memory providers)             |
| `npm run e2e`                              | Playwright (mobile + desktop viewports)                 |
| `npm run seed`                             | Demo users against the configured provider              |
| `npm run doctor`                           | Verify env files, secrets and provider credentials      |
| `npm run typecheck`                        | `tsc --noEmit`                                          |
| `npm run lint`                             | ESLint                                                  |
| `npm run prisma:migrate` / `prisma:deploy` | Dev / production Prisma migrations                      |

---

## 8. Project layout (single app)

```
app/                 Next.js App Router (UI + /api/v1/*)
components/          React UI (typing game, chat, admin)
hooks/ stores/       Client state
lib/
  types/ validation/ domain/ utils/ config/ api-client/   shared pure modules
  access/ auth/ data/ services/ …                         server + client app code
prisma/              PostgreSQL schema + migrations
public/typing-words/ English + Bengali word lists
tests/               Vitest unit + API tests
e2e/                 Playwright
scripts/             seed-dev.ts, doctor.mjs
server.ts            Standalone server (Next.js + WebSocket + outbox worker)
proxy.ts             Security headers + CSP + request id
.env.example         Annotated environment template
howto.md             This file
```

There is **no** `apps/` or `packages/` workspace and **no** Turborepo. Shared
code is plain TypeScript under `lib/`, imported with `@/` and `@mt/*` path
aliases.

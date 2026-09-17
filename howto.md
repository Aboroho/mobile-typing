# How to set up Keypad

This is a **single Next.js app** (no monorepo). One install, one `npm run dev`,
and the same UI works on phones and desktops.

---

## 1. Prerequisites

- **Node.js 20.11+** (`node --version`)
- npm 10+ (ships with Node)
- Optional: a Firebase project if you want real Auth / Firestore / Storage

---

## 2. Install and run (local, no Firebase)

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

| Variable            | Default  | Meaning                                      |
| ------------------- | -------- | -------------------------------------------- |
| `DATA_PROVIDER`     | `memory` | In-process store; wiped on restart           |
| `AUTH_PROVIDER`     | `dev`    | Built-in email/password (scrypt)             |
| `STORAGE_PROVIDER`  | `memory` | In-process media blobs                       |
| `SEED_SECRET_CODE`  | `opensesame` | Type this into the game to reveal sign-in |
| `APP_SECRET`        | (dev default) | Signs access sessions — change in prod |

These defaults are **refused in a production build**. You never need Firebase
just to try the typing game or the access flow locally.

### Demo accounts

With the dev server running:

```bash
npm run seed
```

This registers the administrator account (`ADMIN_EMAIL` with the password from
`ADMIN_PASSWORD` — both read from `.env.local` / the environment) and a peer
account through the public API, and prints the admin uid for `ADMIN_UID`. The
secret code typed to unlock the gate comes from `SEED_SECRET_CODE`. The script
refuses to run when `ADMIN_EMAIL` or `ADMIN_PASSWORD` is unset.

How the accounts are created follows the server's `AUTH_PROVIDER`:

| Server | What the seed does |
| --- | --- |
| `AUTH_PROVIDER=dev` (default) | Registers email + password through `/api/v1/auth/register`. |
| `AUTH_PROVIDER=firebase` | Signs up / signs in through the Identity Toolkit REST API with `NEXT_PUBLIC_FIREBASE_API_KEY` (the same call the browser SDK makes), then registers with the resulting Firebase ID token. Without that key the seed stops with an explanatory message instead of a bare 401. |

Re-running the seed is safe: existing accounts are picked up through `/login`
rather than registered again, and `ADMIN_UID` is printed either way.

---

## 3. The `.env` file

Copy the example, then edit:

```bash
cp .env.example .env.local
```

Next.js loads `.env.local` automatically. **Never commit** `.env`, `.env.local`,
or real secrets. Anything prefixed with `NEXT_PUBLIC_` is shipped to the browser
and is public by design.

### Minimum for local development

```env
APP_ENV=development
DATA_PROVIDER=memory
AUTH_PROVIDER=dev
STORAGE_PROVIDER=memory
APP_SECRET=change-me-to-a-32-byte-random-hex
DEV_SESSION_SECRET=change-me-too-32-byte-random-hex
SEED_SECRET_CODE=opensesame
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe123!
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=Keypad
```

Generate strong secrets with:

```bash
openssl rand -hex 32
```

### Full variable reference

See [`.env.example`](./.env.example) for every key with comments. Summary:

| Group | Variables | Required when |
| --- | --- | --- |
| App | `APP_ENV`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_NAME` | Always |
| Providers | `DATA_PROVIDER`, `AUTH_PROVIDER`, `STORAGE_PROVIDER` | Always |
| Secrets | `APP_SECRET`, `DEV_SESSION_SECRET` | Always (`APP_SECRET` ≥ 16 chars) |
| Access | `SEED_SECRET_CODE`, `SECRET_CODE_MAX_LENGTH` | Local bootstrap |
| Admin | `ADMIN_UID` or `ADMIN_EMAIL` | Admin UI / claims |
| Firebase client | `NEXT_PUBLIC_FIREBASE_*` | `AUTH_PROVIDER=firebase` |
| Firebase Admin | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | `DATA_PROVIDER=firestore` or Firebase Auth/Storage |
| WebRTC | `STUN_SERVER_URL`, `TURN_SERVER_*` | Audio calls off-LAN |
| Limits / security | `RATE_LIMIT_*`, `CSP_MODE`, `LOG_LEVEL` | Optional tuning |

---

## 4. What if data / config is missing?

The app is designed to **degrade safely** instead of crashing the public UI.

| Missing piece | What you see / what happens |
| --- | --- |
| No `.env.local` at all | Dev defaults from `lib/config/server-env.ts` apply. Game and memory providers still work. |
| Blank optional keys (`ADMIN_UID=`, empty Firebase fields) | Treated as unset. Safe to copy `.env.example` as-is. |
| Empty / invalid `APP_SECRET` | Server env parse fails on boot / first API call. Set ≥ 16 characters. |
| Word list file missing (`public/typing-words/*.txt`) | Start test still works — a built-in English/Bengali fallback list is used and a small warning is shown. |
| `DATA_PROVIDER=firestore` but no Admin credentials | Server routes that touch the database throw a clear error. Switch back to `memory` or fill `FIREBASE_*`. |
| `AUTH_PROVIDER=firebase` but no `NEXT_PUBLIC_FIREBASE_*` | Client auth cannot start. Use `AUTH_PROVIDER=dev` locally. |
| `npm run seed` fails with `complete the Firebase sign-up first` | The server runs `AUTH_PROVIDER=firebase`, so `/api/v1/auth/register` needs a Firebase ID token that only the client SDK has. Set `NEXT_PUBLIC_FIREBASE_API_KEY` so the seed can obtain one, or seed against `AUTH_PROVIDER=dev`. |
| `npm run seed` fails with 429 `RATE_LIMITED` | Registration is limited to 5 calls / 10 min / IP (`auth:register`). Wait for the window, or restart the dev server to reset the in-memory counters. |
| No `ADMIN_UID` / `ADMIN_EMAIL` | Admin routes return forbidden; the rest of the app is fine. Run `npm run seed` then set `ADMIN_UID`. |
| No TURN server | Calls may work on the same LAN via STUN; mobile networks usually need TURN. |
| Empty Firestore (fresh project) | Access config is bootstrapped from `SEED_SECRET_CODE` on first boot (`instrumentation.ts`). |
| Production build with `memory` / `dev` providers | **Hard fail** — `assertFallbackAllowed` refuses so you cannot ship insecure defaults. |

### Quick health check

```bash
curl -s http://localhost:3000/api/v1/health | jq
```

You should see `dataProvider`, `authProvider`, and `ok: true`. If this fails,
the server did not start or env parsing threw — check the terminal running
`npm run dev`.

### Typing game still won't start?

1. Hard-refresh the browser (cache can serve a stale bundle).
2. Confirm `public/typing-words/en.txt` exists (optional thanks to the fallback).
3. Open DevTools → Console for client errors; Network for `/typing-words/en.txt`.
4. Ensure you are on `/` (or `/typing-game`) and the page title is “Keypad”.

---

## 5. Production / Firebase sketch

```bash
# 1. Fill Firebase client + Admin vars in the host (e.g. Vercel) env
# 2. Switch providers
DATA_PROVIDER=firestore
AUTH_PROVIDER=firebase
STORAGE_PROVIDER=firebase
APP_ENV=production
APP_SECRET=<openssl rand -hex 32>

# 3. Deploy rules
npm run firebase:deploy:rules

# 4. Build
npm run build && npm run start
```

Step-by-step Firebase provisioning, TURN, and Vercel notes live in
[`docs/deployment.md`](./docs/deployment.md).

---

## 6. Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server on `0.0.0.0:3000` |
| `npm run build` / `npm start` | Production build + serve |
| `npm test` | Unit + API tests (Vitest, memory providers) |
| `npm run e2e` | Playwright (mobile + desktop viewports) |
| `npm run seed` | Demo users against a running server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

---

## 7. Project layout (single app)

```
app/                 Next.js App Router (UI + /api/v1/*)
components/          React UI (typing game, chat, admin)
hooks/ stores/       Client state
lib/
  types/ validation/ domain/ utils/ config/ api-client/   shared pure modules
  access/ auth/ data/ services/ …                         server + client app code
public/typing-words/ English + Bengali word lists
tests/               Vitest unit + API tests
e2e/                 Playwright
firebase/            Rules, indexes, seed notes
scripts/             seed-dev, set-admin-claim
.env.example         Annotated environment template
howto.md             This file
```

There is **no** `apps/` or `packages/` workspace and **no** Turborepo. Shared
code is plain TypeScript under `lib/`, imported with `@/` and `@mt/*` path
aliases.

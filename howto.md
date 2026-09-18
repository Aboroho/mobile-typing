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
| `STORAGE_PROVIDER`  | `memory` | In-process media blobs                       |
| `SEED_SECRET_CODE`  | `opensesame` | Type this into the game to reveal sign-in |
| `APP_SECRET`        | (dev default) | Signs access sessions — change in prod |

These defaults are **refused in a production build**. You never need Firebase
just to try the typing game or the access flow locally.

**Authentication is the exception: it always uses Firebase.** There is
no development password provider or silent fallback — the browser
verifies passwords with the Firebase client SDK and the API verifies the
resulting ID tokens with the Admin SDK. So to sign up, sign in or chat locally,
add the Firebase blocks from section 3 and enable Email/Password in the console
(`npm run doctor` checks all of it). For a local-only alternative,
`npm run e2e:auth` explicitly starts Firebase's Auth emulator with a demo project;
see [docs/auth-testing.md](./docs/auth-testing.md).

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

The accounts are created in Firebase first — the Identity Toolkit REST API with
`NEXT_PUBLIC_FIREBASE_API_KEY`, the same call the browser SDK makes — and the
resulting ID token is presented to `/api/v1/auth/register`. The password never
goes to this application's API. Without that key the seed stops with an
explanatory message instead of a bare 401.

Re-running the seed is safe: Firebase reports whether an account already exists,
so existing accounts are signed in (and their name repaired) rather than
registered again, and `ADMIN_UID` is printed either way.

---

## 3. The `.env` file

Copy the example, then edit:

```bash
cp .env.example .env.local
```

Next.js loads `.env.local` automatically. **Never commit** `.env`, `.env.local`,
or real secrets. Anything prefixed with `NEXT_PUBLIC_` is shipped to the browser
and is public by design.

> **Precedence trap.** Next.js reads `.env.local` *before* `.env`, and a key set
> to an empty value still counts as set. So a copied template with blank
> `NEXT_PUBLIC_FIREBASE_*` / `FIREBASE_*` lines silently hides the real
> credentials in `.env`, and the server runs the Firebase providers with no
> Firebase project. Keep the values in **one** file — `.env.local` — or delete
> the blank lines from it. `npm run doctor` prints the file each value came from
> and names every shadowed key.

### Minimum for local development

```env
APP_ENV=development
DATA_PROVIDER=memory
STORAGE_PROVIDER=memory
APP_SECRET=change-me-to-a-32-byte-random-hex
SEED_SECRET_CODE=opensesame
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe123!
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=Keypad

# Firebase — required for authentication in every environment.
# Web config (browser): Project settings -> Your apps -> SDK setup and configuration
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
# Admin SDK (server): Project settings -> Service accounts -> Generate new private key
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

With that in place the typing game, sign-up, sign-in and the chat all work
locally against in-memory data. Without the Firebase blocks the game still works
and nobody can sign in.

Generate strong secrets with:

```bash
openssl rand -hex 32
```

### Full variable reference

See [`.env.example`](./.env.example) for every key with comments. Summary:

| Group | Variables | Required when |
| --- | --- | --- |
| App | `APP_ENV`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_NAME` | Always |
| Providers | `DATA_PROVIDER`, `STORAGE_PROVIDER` | Always |
| Secrets | `APP_SECRET` | Always (≥ 16 chars; signs access sessions, not auth sessions) |
| Access | `SEED_SECRET_CODE`, `SECRET_CODE_MAX_LENGTH` | Local bootstrap |
| Admin | `ADMIN_UID` or `ADMIN_EMAIL` | Admin UI / claims |
| Firebase client | `NEXT_PUBLIC_FIREBASE_*` | **Always** — the browser signs users up and in |
| Firebase Admin | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Live Firebase — the server verifies ID tokens (and needs credentials for Firestore/Storage). Local Auth emulator tests need only the demo project id. |
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
| No `NEXT_PUBLIC_FIREBASE_*` | Nobody can sign up or sign in: the sign-in form itself says `Firebase client configuration is incomplete — set NEXT_PUBLIC_FIREBASE_API_KEY, …` and the boot log names the variables (`config.issue` / `firebase_auth_without_client_config`). There is no fallback and no silent failure. |
| No `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | The server cannot verify ID tokens, so every auth request is 401 and the boot log records `firebase_admin_credentials_missing`. Required even when data and storage are in memory. |
| Sign-up / sign-in returns `UNAUTHENTICATED` — `complete the Firebase sign-up first` | The API received no valid Firebase credential. Check browser config, matching client/Admin project ids, service-account credentials and network access. Run `npm run doctor`; the API intentionally does not expose credential-verification details. |
| The form says Firebase is unconfigured despite complete env values | Restart/rebuild after changing `NEXT_PUBLIC_*`. These must be read with literal `process.env.NEXT_PUBLIC_*` properties, as in `lib/config/public-env.ts`; passing `process.env` into the schema does not inline values into a browser bundle. |
| `DATA_PROVIDER=firestore` / `STORAGE_PROVIDER=firebase` without Admin credentials | Every request touching data or media fails with a 500; boot logs `config.issue` (`firebase_admin_credentials_missing`). Use the `memory` providers locally. |
| `npm run seed` fails with `complete the Firebase sign-up first` | `/api/v1/auth/register` needs a Firebase ID token that only the Identity Toolkit can issue. Set `NEXT_PUBLIC_FIREBASE_API_KEY` (and the other web values) so the seed can obtain one; the script stops with that explanation rather than a bare 401. |
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

### Read the boot log first

On every start the server reviews the environment (`lib/config/diagnostics.ts`)
and logs one `config.issue` line per problem it can predict — a Firebase
provider without Firebase credentials, placeholder secrets, fallback providers
in a production build. Each line's `detail` field names the exact variables to
change, which is usually faster than decoding the first failing request:

```json
{"level":"error","message":"config.issue","fields":{"reason":"firebase_auth_without_client_config","detail":"Firebase Authentication is required but the browser configuration is missing — set NEXT_PUBLIC_FIREBASE_API_KEY, … . Every request that needs a user will fail with UNAUTHENTICATED.","phase":"boot"}}
```

### Typing game still won't start?

1. Hard-refresh the browser (cache can serve a stale bundle).
2. Confirm `public/typing-words/en.txt` exists (optional thanks to the fallback).
3. Open DevTools → Console for client errors; Network for `/typing-words/en.txt`.
4. Ensure you are on `/` (or `/typing-game`) and the page title is “Keypad”.

---

## 5. Running on Firebase (locally or in production)

The Firebase providers are not production-only. Point `npm run dev` at your
project and everything — accounts, conversations, messages, media — is stored
there instead of in process memory. Nothing else has to run on your machine: no
emulator, no local database, no daemon. The Admin SDK talks to Firebase over
HTTPS, and the browser talks to Firebase Auth directly.

```bash
# 1. Console, once per project:
#    Authentication → Sign-in method → Email/Password → Enable
#    Firestore Database → Create database (production mode)
#    Storage → Get started (note the bucket name)
#    Project settings → Service accounts → Generate new private key

# 2. Put the web config + Admin credentials in ONE file (.env.local)
DATA_PROVIDER=firestore
STORAGE_PROVIDER=firebase
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=<project-id>.firebasestorage.app
APP_SECRET=<openssl rand -hex 32>

# 3. Check it before relying on it — names every missing console step
npm run doctor

# 4. Deploy the rules and the composite indexes the queries need
firebase use <project-id>       # once; writes .firebaserc (firebase.json is in the repo root)
npm run firebase:deploy:rules

# 5. Run
npm run dev                     # or, for a deployment: npm run build && npm run start
```

`APP_ENV=production` belongs to a production deployment only: together with
`NODE_ENV=production` it refuses the memory data and storage providers outright,
which is what you want on a server and not what you want while iterating locally.
Authentication is not part of that switch — it is always Firebase.

Step-by-step Firebase provisioning, TURN, and Vercel notes live in
[`docs/deployment.md`](./docs/deployment.md).

---

## 6. Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server on `0.0.0.0:3000` |
| `npm run build` / `npm start` | Production build + serve |
| `npm test` | Unit + API tests (Vitest, memory providers) |
| `npm run e2e` | Playwright game/access gate (mobile + desktop viewports) |
| `npm run e2e:auth` | Isolated emulator-backed signup/login, with both real Firebase SDKs |
| `npm run seed` | Demo users against a running server |
| `npm run doctor` | Verify the Firebase project, credentials and env precedence from this machine |
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

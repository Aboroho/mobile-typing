# Testing signup and login

## The flow

`components/auth/auth-panel.tsx` → `stores/auth-store.ts` → Firebase browser SDK
(`lib/client/auth-client.ts`) → `/api/v1/auth/register` or `/login` → Admin SDK
verification and a profile in the selected data provider. Passwords go only to
Firebase; this app receives an ID token and issues an httpOnly session cookie.
The auth response also confirms whether the secret-code access cookie was bound
to the user. The access store must mirror that binding before rendering chat.

Public Firebase settings are read as literal `process.env.NEXT_PUBLIC_*`
properties in `lib/config/public-env.ts`. Passing `process.env` as a whole works
on Node but leaves the browser without those settings. Restart development or
rebuild production whenever public environment values change.

## Repeatable local browser test (no live project or private key)

Stop any server on port 3000, then run:

```sh
npm ci
npm run e2e:install
npm run e2e:auth
# Also exercise direct sign-in with the game disabled:
E2E_TYPING_GAME=false npm run e2e:auth
```

The suite starts the official Firebase Auth emulator (Node only, no Java needed)
for `demo-keypad` on port 9199 and the Next.js app on port 3000. It overrides local
env values with demo web config, blank Admin credentials, memory data/storage and
CSP enforcement. It does not reuse an unknown running server. The pinned Firebase
CLI is fetched with `npx`; an installed CLI can be supplied via `FIREBASE_CLI`.

Both mobile and desktop Chromium exercise:

- signup and opening chat, with exactly one profile-registration request;
- persisted identity after reloading;
- cookie-only protected API access;
- logout, cookie removal and rejection of a copied pre-logout session cookie;
- rejection of an incorrect password, followed by a successful login;
- preservation of the original profile/name, no passwords in app API payloads,
  no browser runtime/CSP errors and no requests to live Google Auth endpoints.

Only throwaway emulator accounts are created; they are deleted after each test.
The fixture servers shut down when the suite exits. Unit tests additionally cover
reauthentication, denied access bindings, in-flight privacy locks, duplicate
StrictMode effects and stale session responses.

## Interactive emulator development

Start the emulator in one terminal:

```sh
npx --yes firebase-tools@15.30.2 emulators:start --only auth --project demo-keypad --config firebase.auth-test.json
```

Use these **local-only** settings in your ignored `.env.local` and run
`npm run dev` in a second terminal:

```dotenv
APP_ENV=development
DATA_PROVIDER=memory
STORAGE_PROVIDER=memory
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199
FIREBASE_PROJECT_ID=demo-keypad
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
NEXT_PUBLIC_FIREBASE_API_KEY=demo-keypad-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-keypad.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-keypad
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=1234567890
NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:local-keypad
NEXT_PUBLIC_ENABLE_TYPING_GAME=true
SEED_SECRET_CODE=opensesame
```

Set `APP_SECRET` to a random value from `openssl rand -hex 32`. Open the app, start
the typing test, type the bootstrap code and create a test account. Next config
derives `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_ENABLED` automatically; do not set it
by hand. Emulator requests are same-origin, including on a development tunnel.
The emulator accepts unsigned tokens, so it is explicitly forbidden in production.

## Verify a live Firebase project separately

Emulator success proves the application flow, not a project's cloud permissions,
provider settings, Firestore database/indexes, bucket or network connectivity.

1. Revoke any service-account private key shared in a chat or committed to Git;
   replace it locally using Firebase/Google Cloud's service-account settings.
   Rotate exposed account passwords and replace placeholder signing secrets too.
2. Remove `FIREBASE_AUTH_EMULATOR_HOST`, restore the real web/Admin config to the
   **same project**, and select `DATA_PROVIDER=firestore`, `STORAGE_PROVIDER=firebase`.
3. Enable Firebase Authentication's Email/Password provider, check deployment
   domains and use `npm run doctor` from a machine that can reach Google APIs.
   The doctor creates and removes temporary probes in that project.
4. Restart/rebuild, then create a throwaway account through the UI, sign out and
   sign back in. Remove that test account/profile afterwards.

`AUTH_PROVIDER` and `DEV_SESSION_SECRET` are obsolete in this version.
`ADMIN_PASSWORD` is only read by the seed script; putting it in an env file does
not create an account or change a Firebase user's password.

# Deployment

Covers environment variables, Firebase provisioning (project, Authentication,
Firestore, Storage, rules), WebRTC/TURN configuration, administrator setup,
Vercel deployment and troubleshooting.

## 1. Environment variables

Copy `.env.example` to `.env.local`. Everything prefixed `NEXT_PUBLIC_` is
inlined into the browser bundle and is **public by design** — no secret may ever
use that prefix.

### Application

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Set by the runtime |
| `APP_ENV` | `development` | `production` here (together with `NODE_ENV=production`) disables every fallback provider |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | Canonical public URL |
| `NEXT_PUBLIC_APP_NAME` | `Keypad` | Shown as the app name |
| `NEXT_PUBLIC_ENABLE_TYPING_GAME` | `true` | `false` skips the typing-game disguise and secret-code gate entirely; visitors go straight to sign-in and chat. Read by both the browser and the API, so the two sides never disagree about whether an access session is required |

### Providers

| Variable | Values | Notes |
| --- | --- | --- |
| `DATA_PROVIDER` | `memory` \| `firestore` | `memory` keeps everything in process memory; refuses to run in production |
| `AUTH_PROVIDER` | `dev` \| `firebase` | `dev` uses scrypt-hashed passwords in the database |
| `STORAGE_PROVIDER` | `memory` \| `firebase` | `memory` keeps bytes in process memory |

### Firebase client (public)

`NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
`NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
`NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` — copy
from Project settings → *Your apps* → SDK setup and configuration.

### Firebase Admin (server only)

`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
Generate at Project settings → **Service accounts** → *Generate new private key*.
When pasting into a dashboard field, escape newlines as `\n`.

### Secrets

| Variable | Notes |
| --- | --- |
| `APP_SECRET` | Signs access challenges and access sessions. ≥ 16 characters; use `openssl rand -hex 32` |
| `DEV_SESSION_SECRET` | Signs dev session cookies. Same rules. Only used when `AUTH_PROVIDER=dev` |
| `SECRET_CODE_MAX_LENGTH` | `15`. The rolling keystroke buffer never exceeds this, so a longer code could never match |
| `SEED_SECRET_CODE` | Bootstrap code, applied on first boot until an administrator changes it. Change it immediately after deploying |

### Administrator

| Variable | Notes |
| --- | --- |
| `ADMIN_UID` | **Canonical.** The uid of the administrator account. Never sent to any client |
| `ADMIN_EMAIL` | Convenience for development, where a generated uid is not known in advance. Ignored in favour of `ADMIN_UID` when both are set |

### WebRTC

| Variable | Notes |
| --- | --- |
| `STUN_SERVER_URL` | Comma separated list. `stun:stun.l.google.com:19302` works on a LAN |
| `TURN_SERVER_URL` | Comma separated `turn:`/`turns:` URLs |
| `TURN_SERVER_USERNAME`, `TURN_SERVER_CREDENTIAL` | Shared credentials, or short-lived HMAC credentials if you front them |

ICE configuration is only exposed through the authenticated
`GET /api/v1/calls/ice-servers` route.

### Rate limiting and logging

`RATE_LIMIT_WINDOW_MS` (60000), `RATE_LIMIT_MAX` (120), `CSP_MODE`
(`enforce` | `report` | `off`), `ENABLE_SECURITY_HEADERS` (true),
`LOG_LEVEL` (`debug` | `info` | `warn` | `error`).

## 2. Firebase project configuration

```bash
npm install -g firebase-tools
firebase login
firebase projects:create <project-id>
firebase use <project-id>
```

Enable **Authentication → Sign-in method → Email/Password**.

## 3. Firebase Authentication setup

1. Enable the Email/Password provider.
2. Add your authorised domains (Authentication → Settings → Authorised domains)
   — the Vercel preview domain needs adding for preview deployments.
3. Create the administrator's account through the app itself (register in the
   typing game after unlocking), then read the uid from the admin panel or from
   `scripts/seed-dev.mjs` output and set `ADMIN_UID`.
4. Grant the custom claim that `firestore.rules` checks:

```bash
ADMIN_UID=<uid> node scripts/set-admin-claim.mjs
```

The user must sign out and back in for the claim to appear in their token. The
server additionally compares the uid against `ADMIN_UID` on every admin request,
so the claim is not the only line of defence.

## 4. Firestore setup

Create the database in production mode. Deploy the composite indexes:

```bash
firebase deploy --only firestore:indexes
```

Without them, the conversation list, message pagination, call lookup and admin
filters fail with a "missing index" error that names the index to create.

## 5. Storage setup

Create a default bucket. Objects are written under
`media/{ownerId}/{conversationId|drafts}/{mediaId}.{ext}`. There are no public
paths and no public URLs: retrieval always goes through an authorised route, or
through a signed URL with a 60-second TTL minted by that route.

## 6. Firestore security rules

`firebase/firestore.rules` — participants-only reads, **no** client writes,
administrator access via `role == 'admin'`, and the secret-code document readable
only by the Admin SDK.

```bash
firebase deploy --only firestore:rules
```

## 7. Storage security rules

`firebase/storage.rules` denies all client reads and writes. Deploy with
`firebase deploy --only storage.rules`.

If you later want direct browser uploads, replace the `write` rule with a
request-scoped check on `request.resource.size` and
`request.resource.contentType`, and keep deletes admin-only so soft deletion
cannot be bypassed.

## 8. WebRTC and TURN

STUN alone connects peers that are both on permissive NATs. On mobile networks
(symmetric NAT) a TURN relay is required, otherwise calls fail after ringing.

Recommended: run [coturn](https://github.com/coturn/coturn) or use a hosted
service, then set:

```
STUN_SERVER_URL=stun:stun.l.google.com:19302
TURN_SERVER_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
TURN_SERVER_USERNAME=webrtc
TURN_SERVER_CREDENTIAL=<secret>
```

The call UI surfaces a "connection failed — a TURN server may be required" hint
when the ICE connection state reaches `failed`, so this failure mode is visible
rather than silent.

## 9. Deployment to Vercel

1. Import the repository. The framework preset is **Next.js**; the root directory
   is the repository root (single Next.js package).
2. Build command `npm run build`, output `.next` (the config sets
   `output: 'standalone'`).
3. Add every environment variable from `.env.example` except `NODE_ENV`.
4. Deploy, then in `/admin/settings` change the secret code with the `rotate`
   strategy.

Vercel-specific constraints:

- **Request body limit is 4.5 MB.** Images are compressed client side to at most
  1600 px on the longest edge and stay well under it. `VOICE_MAX_BYTES` is 8 MB,
  so a voice message longer than roughly 4 minutes of high-bitrate audio can
  exceed the limit and will be rejected with `413`. If you need longer voice
  messages, upload directly to Storage from the browser with a scoped rule (see
  §7) — the two-step `upload-intent` → `upload` interface is already shaped for
  that swap.
- **Serverless functions are stateless.** The in-process SSE bus only delivers
  events between requests handled by the *same* instance, so on a multi-instance
  deployment realtime updates fall back to the client's periodic refresh. The
  documented upgrade path is Firestore change feeds (`docs/decisions.md`).
- **`DATA_PROVIDER=memory` loses everything on every cold start.** It is refused
  outright in production builds.

## 10. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Refusing to use the memory fallback in production` | `DATA_PROVIDER`/`AUTH_PROVIDER`/`STORAGE_PROVIDER` are not set to their Firebase values |
| `Invalid environment: APP_SECRET: Too small` | `APP_SECRET` must be at least 16 characters |
| Typing the code does nothing | The buffer is at most 15 characters and the match is case sensitive and consecutive. Check `/api/v1/access/status` for the current `maxLength` and `epoch` |
| Login succeeds but the chat does not open | The access session is missing, expired, or from a previous epoch. `GET /api/v1/access/status` returns `unlocked: false` in that case |
| Calls ring and then fail | No TURN server reachable — configure one (§8) |
| Firestore "missing index" error | Run `firebase deploy --only firestore:indexes` |
| Images fail to send with `415` | The bytes are not a supported image type; the declared MIME type is ignored on purpose |
| `429` on login | 8 attempts per 10 minutes per email |
| Preview deployment cannot sign in | Add the preview domain to Firebase Authorised domains |

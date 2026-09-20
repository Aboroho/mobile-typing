# Security

## Threat model

The app protects private 1:1 conversations from three distinct adversaries:

1. **A bystander with physical access** to an unlocked phone — addressed by the
   disguise, the triple-tap lock and the visibility lock.
2. **A curious or malicious user of the app** — addressed by per-request
   server-side authorisation, 1:1 participant checks and soft deletes that keep
   content out of reach of non-participants.
3. **An attacker who reads the network traffic or the JavaScript bundle** — they
   will find the secret code. It grants no data access whatsoever; see "The
   secret code is not a secret" below.

What the app does **not** claim to defend against: a compromised device with
screen-capture access, a determined recipient who photographs the screen with a
second camera, or an adversary who controls the network _and_ the browser.

## Defence in depth

There is exactly one trust boundary: the API route. The browser is untrusted
input.

1. **Every route authorises independently** — `requireAccess` (valid, correctly
   bound, unexpired access session), `requireUser` (verified session token),
   and `requireAdminAccess` (both, plus the configured administrator identity)
   run on every request. A user id, uid or role in a body or query string is
   never trusted.
2. **Storage has no direct client path.** Media bytes live in the configured
   storage provider (`memory` / `local` / `s3`) under random non-guessable
   object keys, and leave the server only through the authorised
   `GET /api/v1/media/{id}/content` (or the admin equivalent, which is
   audit-logged). There is no signed-URL bypass.
3. **The database is reachable only by the server.** Services touch data solely
   through the provider interface (`getData()`); the memory provider keeps
   everything in process-local Maps and the Prisma provider talks to
   PostgreSQL. No client credential reaches either store.

## The secret code is not a secret

`POST /api/v1/access/challenge` returns the plaintext code, because the
keystroke match has to happen in the browser. It is therefore treated as public
information:

- it never gates an API route — every route calls `requireAccess` (is there a
  valid, correctly bound, unexpired session?) and `requireUser` (is this a
  verified account?) independently;
- it is never rendered in the UI, never written to logs, and the admin panel
  shows only its length, epoch and a fingerprint;
- a valid session is still required to read anything, and it is bound to the
  user id it was issued for.

The consequence is that knowing the code lets you see the login form and nothing
else.

## Credentials

Authentication is email + password verified server-side against an Argon2id
hash, in every environment. There is no development authentication provider and
no fallback: without the database (or the memory provider in development)
nobody can sign up or sign in.

| Party         | What it does                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser       | Sends `{ name?, email, password }` to `POST /auth/register` / `POST /auth/login`. The password travels in the POST body over TLS and is never logged. It is the only place a plaintext password exists.                                                                                                                                                                 |
| This API      | Hashes with Argon2id on register, verifies with `verifyPassword` on login, and takes the uid and email **from the verified session** — never from a request body. Stores the hash in the `User` table, where no read path above the data layer can see it.                                                                                                              |
| Session token | A 256-bit opaque token, stored hashed in `UserSession`, delivered as the httpOnly `mt_session` cookie (browsers) or an `Authorization: Bearer` token (API/WebSocket clients). Lifetime is `SESSION_DURATION_HOURS` (default 336 = two weeks). This is what SSE streams and page reloads authenticate with, because `EventSource` cannot send an `Authorization` header. |

Login failures are deliberately indistinguishable: a wrong password, an unknown
email and a **disabled account** all return the same 401
`unable to sign in with those details`, so nothing can be used to enumerate
accounts. The server log records the specific `auth.login_*` line for forensics.
Registration is safe to retry: a known email with the correct password
re-issues a session, while a wrong password gets a generic 401 — account
existence is never disclosed.

Password reset by email is **not implemented** — there is no reset endpoint, and
the sign-in UI reports "not configured" rather than pretending to send mail.

**Logout revokes the session server-side** before the browser state is cleared,
so a token copied earlier stops working immediately. Revocation is
per-session: other devices stay signed in.

## Cookies

| Cookie       | Contents                                                               | Flags                                                          |
| ------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `mt_access`  | Signed access session (audience `access-session`, epoch, optional uid) | `httpOnly`, `SameSite=Lax`, `Secure`, 30 min                   |
| `mt_session` | Opaque session token (hashed server-side in `UserSession`)             | `httpOnly`, `SameSite=Lax`, `Secure`, `SESSION_DURATION_HOURS` |

Neither is readable from JavaScript. The access cookie is **bound to a user**
when one is known: `accessBindingCookie()` returns `null` if the browser never
unlocked, or if its session predates the current epoch, so logging in can never
become a way around the typing-game gate.

## Input handling

- Every request body and query string is parsed with a Zod schema from
  `@mt/validation` **before** any service runs. A parse failure is a
  `422 VALIDATION_ERROR` with per-field details.
- Message text is normalised (`NFC`), stripped of control characters and bidi
  overrides, bounded to 8 consecutive newlines, trimmed and capped at
  `MESSAGE_MAX_LENGTH` (4000).
- Names are stripped of markup and capped at 48 characters; search terms at 64.
- React escapes all rendered text by default, so there is no `dangerouslySetInnerHTML`
  anywhere in the codebase.
- Uploads are validated by **magic bytes**, not by the declared MIME type or file
  extension. The stored extension is derived from the sniffed type through a
  whitelist, so `evil.png` containing a script is rejected with
  `415 UNSUPPORTED_MEDIA_TYPE` rather than stored.

## Headers

`proxy.ts` sets, on every response:

```
Content-Security-Policy: default-src 'self';
  script-src 'self' 'nonce-<random>' 'strict-dynamic' ('unsafe-eval' in dev only);
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  media-src 'self' blob: mediastream:; font-src 'self' data:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'self';
  form-action 'self'; object-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), geolocation=(), interest-cohort=(), microphone=(self)
Cross-Origin-Opener-Policy: same-origin
```

The CSP is nonce-based rather than relying on `'unsafe-inline'` for scripts:
the App Router hydrates with inline `<script>` tags, so a bare
`script-src 'self'` would block hydration outright ("Loading words…" forever).
Next.js reads the nonce back out of the header and stamps it onto its own
inline scripts automatically. `connect-src 'self'` is deliberately tight — the
app talks to no third party at all, so API, SSE and `blob:` media playback are
all same-origin. `CSP_MODE=report-only` / `off` and
`ENABLE_SECURITY_HEADERS=false` are escape hatches for local debugging only.

## Rate limiting

See the table in [`api.md`](./api.md#rate-limits). Counters live in
process-local Maps in both providers, keyed by client IP + route (+ email where
relevant), so credential stuffing and secret-code brute forcing are blunted per
instance even before the (already useless) secret code is guessed.

## Audit logging

`AuditLog` records, at minimum: secret-code changes (with a salted fingerprint,
never the plaintext), user status changes and conversation inspections;
`AdminAccessLog` records every administrator read of someone else's data,
**including every** administrative media-byte read. Entries carry the actor's
uid, IP, user agent and a metadata map. There is no code path that deletes or
edits an audit entry.

## Privacy limitations (honest)

- **Deletion is soft.** Deleting a message or a photo hides it from users and
  keeps the row (and the bytes) for administrators. If your threat model requires
  true erasure, you must add a hard-delete job — the schema keeps
  `metadata.originalText` and the storage object precisely so an administrator
  can still inspect what was removed.
- **The server can read everything.** Messages are not end-to-end encrypted. An
  attacker with database access can read all content.
- **Delivery and read receipts are best effort** over SSE; a client that is
  offline simply does not advance them.

## Screenshot prevention: what is and is not possible

A web page cannot prevent screenshots. What the app does:

- View-once photos are never rendered until the recipient explicitly opens them,
  and the claim is atomic server side, so exactly one view exists.
- The overlay disables the context menu and text selection, sets
  `draggable=false`, and the `<img>` is removed from the DOM the moment the
  viewer closes it (there is no cached `src` left behind).
- Bytes are served with `Cache-Control: no-store`, so the image is not written to
  the HTTP cache, and view-once bytes are only served while the media is in the
  transient `viewing` state.
- The sender is notified when the photo is viewed.

What none of that stops: the OS screenshot shortcut, screen recording, a second
camera, or a browser extension. **A view-once photo is a strong hint, not a
guarantee**, and the UI says so.

## Production checklist

- `APP_SECRET` is a long random value (`openssl rand -hex 32`), at least 32
  characters — it signs access sessions and challenge tokens.
- `ADMIN_UID` is set (canonical) — `ADMIN_EMAIL` is a development convenience.
- The bootstrap secret code (`SEED_SECRET_CODE`) has been changed in
  `/admin/settings` using the `rotate` strategy.
- `DATA_PROVIDER=prisma` with a `DATABASE_URL` that is not the dev default, and
  `STORAGE_PROVIDER=local` (with a `STORAGE_LOCAL_DIR` outside the repo) or
  `s3` (with `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`).
- A TURN server is configured; STUN alone fails behind symmetric NATs.
- TLS terminates at the reverse proxy (or the app), Postgres only listens
  locally, and database backups are scheduled — see
  [`deploy.md`](./deploy.md).

The fallback providers call `assertFallbackAllowed()`, which throws when
`NODE_ENV=production && APP_ENV=production`. A misconfigured production
deployment therefore fails loudly instead of silently storing data in memory.

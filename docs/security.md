# Security

## Threat model

The app protects private 1:1 conversations from three distinct adversaries:

1. **A bystander with physical access** to an unlocked phone — addressed by the
   disguise, the triple-tap lock and the visibility lock.
2. **A curious or malicious user of the app** — addressed by per-request
   server-side authorisation, 1:1 participant checks and soft deletes that keep
   content out of reach of non-participants.
3. **An attacker who reads the JavaScript bundle** — they will find the secret
   code. It grants no data access whatsoever; see "The secret code is not a
   secret" below.

What the app does **not** claim to defend against: a compromised device with
screen-capture access, a determined recipient who photographs the screen with a
second camera, or an adversary who controls the network *and* the browser.

## Defence in depth

Every data access is authorised twice:

1. **Firestore rules** (`firebase/firestore.rules`) deny all client writes and
   restrict reads to participants, with administrators identified by the
   `role == 'admin'` custom claim.
2. **The API layer** re-checks everything with the Admin SDK, which bypasses
   those rules — so a client pointed straight at Firestore still cannot write,
   and a client using our API still cannot read outside its conversations.

Storage rules (`firebase/storage.rules`) deny *all* direct client access to
media objects. Bytes only leave the bucket through
`GET /api/v1/media/{id}/content` (or a 60-second signed URL minted by that same
authorised path).

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

Authentication is Firebase Authentication (email/password) in every environment.
There is no development authentication provider and no fallback: without a
Firebase project nobody can sign up or sign in, and the server says so by naming
the missing variables.

| Party | What it does |
| --- | --- |
| Browser | `createUserWithEmailAndPassword` / `signInWithEmailAndPassword`. It is the only place a password exists, and Firebase is the only party that verifies it. The ID token is held in memory; a Firebase refresh token lives in IndexedDB. |
| This API | `verifyIdToken` / `verifySessionCookie` with `checkRevoked: true`. It reads the uid and email **from the verified token** — never from a request body — and stores no credential of its own. Reauthentication additionally requires `auth_time` within five minutes. |
| Session cookie | `createSessionCookie` on a fresh credential, `mt_session`, httpOnly, `SameSite=Lax`, `Secure` in production, 7 days. This is what SSE streams and page reloads authenticate with, because `EventSource` cannot send an `Authorization` header. |

Login failures are deliberately indistinguishable: a wrong password, an unknown
email and a **disabled account** all read the same, so nothing can be used to
enumerate accounts. The first two are refused by Firebase with
`auth/invalid-login-credentials`, which the browser maps to `unable to sign in
with those details`; an account an administrator disabled cannot obtain a
credential at all (`auth/user-disabled`), and a stale or revoked one is rejected
by the API with the same wording. Account existence is still disclosed by
Firebase's own `auth/email-already-in-use` at sign-up, which the browser maps to
`that email address already has an account`; that is inherent to any working
sign-up form.

Password reset is Firebase's `sendPasswordResetEmail`, called from the browser —
this application never held a password and has no reset endpoint.

**Logout revokes credentials server-side** (`revokeRefreshTokens`) before the
browser signs out, so a session cookie copied earlier stops working. That is
Firebase's account-wide revocation: it ends the session on every device of that
user, not just the one that logged out.

## Cookies

| Cookie | Contents | Flags |
| --- | --- | --- |
| `mt_access` | Signed access session (audience `access-session`, epoch, optional uid) | `httpOnly`, `SameSite=Lax`, `Secure`, 30 min |
| `mt_session` | Firebase session cookie (signed by Google) | `httpOnly`, `SameSite=Lax`, `Secure`, 7 days |

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
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; media-src 'self' blob: mediastream:; font-src 'self' data:;
  connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com
               wss://*.firebaseio.com wss://*.googleapis.com;
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), geolocation=(), interest-cohort=(), microphone=(self)
Cross-Origin-Opener-Policy: same-origin
```

`style-src 'unsafe-inline'` is required by the CSS-in-JS that Tailwind and React
emit. `connect-src` includes the Firebase and Google endpoints so the SDK can
reach them; nothing else is allowed.

## Rate limiting

See the table in [`api.md`](./api.md#rate-limits). Counters live in the data
provider, keyed by client IP + route (+ email where relevant), so credential
stuffing and secret-code brute forcing are blunted even before the (already
useless) secret code is guessed.

## Audit logging

`adminAuditLogs` records, at minimum: secret-code changes (with a salted
fingerprint, never the plaintext), user status changes, conversation
inspections, and **every** administrative media read. Entries carry the actor's
uid, email, IP and a metadata map. There is no code path that deletes or edits an
audit entry.

## Privacy limitations (honest)

- **Deletion is soft.** Deleting a message or a photo hides it from users and
  keeps the row (and the bytes) for administrators. If your threat model requires
  true erasure, you must add a hard-delete job — the schema keeps
  `metadata.originalText` and the Storage object precisely so an administrator
  can still inspect what was removed.
- **The server can read everything.** Messages are not end-to-end encrypted. An
  attacker with the Firebase Admin credentials, or with database access, can read
  all content.
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

- `APP_SECRET` is a long random value (`openssl rand -hex 32`), at least 16
  characters — it signs access sessions and challenge tokens.
- `ADMIN_UID` is set (canonical) — `ADMIN_EMAIL` is a development convenience.
- The bootstrap secret code (`SEED_SECRET_CODE`) has been changed in
  `/admin/settings` using the `rotate` strategy.
- `DATA_PROVIDER=firestore`, `STORAGE_PROVIDER=firebase`, and both Firebase
  credential blocks set (web config for the browser, service account for the
  Admin SDK). Email/Password is enabled in the Firebase console.
- A TURN server is configured; STUN alone fails behind symmetric NATs.
- Firestore and Storage rules are deployed, and `firebase deploy` is part of the
  release process.

The fallback providers call `assertFallbackAllowed()`, which throws when
`NODE_ENV=production && APP_ENV=production`. A misconfigured production
deployment therefore fails loudly instead of silently storing data in memory.

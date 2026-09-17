# Firebase configuration

Everything the app needs from Firebase is declared here so the project can be
provisioned from the repository instead of by hand.

## 1. Create the project

```bash
npm install -g firebase-tools
firebase login
firebase projects:create <project-id>
firebase use <project-id>
```

Enable, in the console:

- **Authentication** → Sign-in method → *Email/Password*
- **Firestore Database** → create in production mode
- **Storage** → create a bucket

## 2. Deploy rules and indexes

The root [`firebase.json`](../firebase.json) points the CLI at the files in this
directory. Select the project first — `firebase use <project-id>` writes a
`.firebaserc`, or pass `--project <project-id>` per command:

```bash
firebase use <project-id>
firebase deploy --only firestore:rules,storage.rules,firestore:indexes
```

The composite indexes in `firestore.indexes.json` are **required**, not optional:
without them the conversation list, message pagination, call lookup and admin
filters fail at runtime with a "missing index" error. The rules are defence in
depth — the server uses the Admin SDK, which bypasses them.

- `firestore.rules` — participants-only reads, no client writes, admin via the
  `role == 'admin'` custom claim.
- `storage.rules` — all media objects private; the app streams bytes through an
  authorised route or mints 60-second signed URLs.
- `firestore.indexes.json` — composite indexes for the conversation list, message
  pagination, call lookup and admin filters.

## 3. Create the service account

Project settings → **Service accounts** → *Generate new private key*. Put the
values in `.env.local` (never in a `NEXT_PUBLIC_*` variable):

```
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

## 4. Mark the administrator

`ADMIN_UID` is the authoritative setting. After your first registration:

```bash
ADMIN_UID=<uid> node scripts/set-admin-claim.mjs
```

The script sets the `role: 'admin'` custom claim, which is what
`firestore.rules` checks. The server additionally compares the uid against
`ADMIN_UID` on every admin request, so the claim is not the only line of defence.

## 5. Switch the app to Firebase

```
DATA_PROVIDER=firestore
AUTH_PROVIDER=firebase
STORAGE_PROVIDER=firebase
```

Restart the dev server. All three fallback providers refuse to initialise when
`NODE_ENV=production` and `APP_ENV=production`, so a missing credential fails the
deployment loudly instead of silently storing data in memory.

## 6. Verify the result

```bash
npm run doctor
```

Checks, in order: that every Firebase variable is actually set in the file that
wins (`.env.local` overrides `.env`, and an empty value still overrides), that
the private key is a real PEM block, that the Admin SDK initialises, that this
machine can reach Google APIs, that Firestore accepts a write, that the
conversation-list composite index exists, that Email/Password sign-up works and
its ID token verifies, and that the Storage bucket exists and accepts an upload.
Each probe is deleted again; the only lasting effect is a created-then-deleted
Auth user (skip it with `npm run doctor -- --no-signup`).

## Timestamps

Documents store ISO-8601 UTC strings rather than Firestore `Timestamp` values.
ISO-8601 sorts lexicographically in chronological order, which lets `orderBy` +
`startAfter` cursors work with plain strings and keeps one serialisation shape
across the memory provider, the API layer and any future client. See
`docs/decisions.md`.

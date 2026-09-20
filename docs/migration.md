# Firebase → PostgreSQL migration notes

> **Historical record — not a setup guide.** This runbook documents the one-time
> cutover from the old Firebase project to the self-hosted PostgreSQL/Argon2
> stack. Firebase has since been removed from the codebase entirely (no config,
> no SDK, no rules files); keep this file only for the collection→table mapping
> in case legacy data still needs importing. For current setup and schema, see
> [`deploy.md`](./deploy.md) and [`database-schema.md`](./database-schema.md).

This document records how data maps from the old Firebase collections to the new
PostgreSQL schema. It was written without network access to the Firebase project
from this sandbox, so the actual migration was not executed here; run it from an
operator machine with both Firebase Admin credentials and a Postgres DSN.

## Collection mapping

| Firebase collection / path                              | PostgreSQL table                      | Notes                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users/{uid}`                                           | `User`                                | `uid` becomes `User.id`. `email`, `displayName` → `email`, `name`. `photoURL` → `photoUrl`. `disabled` from Firebase Auth → `status = 'disabled'`. `createdAt`, `lastLoginAt` carried across. Password hashes are created fresh for migrated users by sending a password-reset flow (see below). |
| `users/{uid}/conversations/...` (subcollection, unused) | —                                     | Dropped; membership lives in `ConversationMember`.                                                                                                                                                                                                                                               |
| `conversations/{cid}`                                   | `Conversation` + `ConversationMember` | Participant list is expanded into a `ConversationMember` row per user. `participantKey = sort(uidA,uidB).join(':')` preserves 1:1 uniqueness.                                                                                                                                                    |
| `conversations/{cid}/messages/{mid}`                    | `Message`                             | `kind` maps to `type`. `deleted/deleteAt/deletedBy/hiddenFor` map directly. Edit history moves to `MessageEdit`.                                                                                                                                                                                 |
| `messages/{mid}/receipts/{uid}`                         | `MessageReceipt`                      | One row per recipient per status (`delivered`, `read`).                                                                                                                                                                                                                                          |
| Storage objects under `gs://keypad-.../media/*`         | `MediaObject`                         | Files are downloaded and written to `STORAGE_LOCAL_DIR` (or copied to S3). The SHA-256 is recomputed and stored. View-once state is migrated; a one-time-viewed item that was not yet claimed is kept in `Delivered` state.                                                                      |
| `access/config` (single doc)                            | `SecretCodeConfiguration`             | The currently active code is copied (plaintext, because the challenge endpoint needs to issue SHA-256 challenges for the rolling buffer).                                                                                                                                                        |
| `auditLogs/{id}`                                        | `AuditLog`                            | Straight copy; `actorUid` is preserved.                                                                                                                                                                                                                                                          |
| `typingSessions/{id}`                                   | `TypingSession`                       | `result` and `attempts` stored as JSONB (`resultJson`, `attemptsJson`).                                                                                                                                                                                                                          |
| Firebase Auth users                                     | `User` + `passwordHash`               | Firebase Auth accounts are listed with the Admin SDK; for each verified email, a `User` row is upserted. Passwords are not migrated (they cannot be exported from Firebase). Send a password-reset email using your email provider so users set a new password on first login.                   |
| Firebase ID tokens / sessions                           | `UserSession`                         | All Firebase sessions are invalidated; users must sign in with password + cookie.                                                                                                                                                                                                                |

## Recommended migration script (run from an operator machine)

1. Create the target Postgres database and run migrations:
   ```bash
   DATABASE_URL=postgres://... npx prisma migrate deploy
   ```
2. Export service-account credentials and run the migrator (outline):
   ```ts
   // scripts/migrate-from-firebase.ts (not shipped — project-specific)
   // 1. admin = initializeApp({ credential: cert(...) });
   // 2. for each user in listAllUsers(admin.auth()): upsert User row
   // 3. for each conversation doc: insert Conversation + ConversationMember rows
   // 4. for each message: insert Message, MessageReceipt, MessageEdit rows
   // 5. for each media object: stream bytes to storage provider + insert MediaObject
   // 6. copy access config to SecretCodeConfiguration
   // 7. copy audit logs (paginated)
   ```
3. Verify counts:
   ```sql
   select 'users' tbl, count(*) from "User"
   union all select 'conversations', count(*) from "Conversation"
   union all select 'messages', count(*) from "Message"
   union all select 'media', count(*) from "MediaObject";
   ```
4. Send reset emails to all users (or stage a cut-over page).
5. Deploy the v2 server with `DATA_PROVIDER=prisma`, `STORAGE_PROVIDER=local|s3`.
6. Run in parallel for a day with both clients pointing at the new backend and
   Firebase writes disabled (set Firestore rules to `allow read;` for admins
   only, and disable new sign-ups via the Firebase console).
7. After verification, delete Firebase data:

   ```bash
   # Not executed from this sandbox — run against your own project.
   firebase firestore:delete --all-collections --project <your-project> -y
   firebase storage:delete --all-files --project <your-project>
   # Delete Firebase users (only after every user has set a password):
   #   for each uid: admin.auth().deleteUser(uid)
   # Then disable/delete the Firebase project in the console.
   ```

These deletion commands were **not** executed because no Firebase credentials
were available in the sandbox. Run them from an operator machine with Owner
rights.

## Things that do not migrate automatically

- **Passwords**: Firebase does not export password hashes in a form that Argon2
  can verify. Use the password-reset flow or send a one-time welcome link.
- **FCM push tokens**: not used in v1 of the new backend; add a mobile push
  registration table if you need it later.
- **Active calls / presence**: transient state — users just reconnect.
- **ID tokens**: all clients must sign in again with email+password.

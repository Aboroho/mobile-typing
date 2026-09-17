# Seed data

There is deliberately very little to seed: the application bootstraps everything
it needs on first boot.

| Document | Who creates it | When |
| --- | --- | --- |
| `appConfig/access` | `ensureAccessConfig()` | On the first `POST /api/v1/access/challenge`, from `SEED_SECRET_CODE` |
| `users/{uid}` | `POST /api/v1/auth/register` | When somebody registers through the typing game |
| `conversations`, `messages`, `media`, `calls` | The corresponding API routes | On use |
| `typingSessions` | `POST /api/v1/typing/sessions` | After each game |
| `adminAuditLogs` | `writeAuditLog()` | On sensitive administrative actions |
| `rateLimits` | `enforceRateLimit()` | Lazily, per window |

## Seeding the access configuration ahead of time

```bash
FIREBASE_PROJECT_ID=… FIREBASE_CLIENT_EMAIL=… FIREBASE_PRIVATE_KEY=… \
SEED_SECRET_CODE=mySecret1 node firebase/seed/seed-access-config.mjs
```

Useful when a deployment pipeline must set the code before the app is publicly
reachable, or when you want to choose the epoch deliberately. The script prints
only a fingerprint of the salted digest, never the code.

## Development demo accounts

`scripts/seed-dev.mjs` registers two demo users through the public API against a
running dev server (so it exercises exactly the same code path as a browser) and
prints the uid to put in `ADMIN_UID`.

```bash
npm run dev          # in one terminal
npm run seed         # in another
```

There is no script that seeds conversations or messages: fabricating chat history
would create data that never passed through the validation, authorisation and
sanitisation the real paths enforce.

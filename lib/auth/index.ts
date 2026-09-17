/**
 * Authentication is Firebase Authentication — there is no second provider and no
 * development fallback.
 *
 *  - `./firebase`  the trusted boundary with the Admin SDK (verify ID tokens and
 *    session cookies, mint session cookies, revoke, disable).
 *  - `./session`   resolves a request to an application profile.
 *  - `./guard`     the `requireUser` / `requireAdmin` / `requireAccess` gates the
 *    API routes call.
 *  - `./cookies` and `./session-cookies`  cookie plumbing.
 *
 * The browser side lives in `lib/client/auth-client.ts` (Firebase client SDK).
 */
export * from './types';
export * from './firebase';

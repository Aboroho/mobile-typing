import { parsePublicEnv, hasFirebaseClientConfig, type PublicEnv } from './public-env';
import { hasFirebaseAdminCredentials, isProduction, parseServerEnv, type ServerEnv } from './server-env';

export type ConfigIssueLevel = 'error' | 'warn';

/**
 * A configuration problem that does not stop the process from booting but will
 * make some part of the product fail later, in a way that is hard to trace back
 * to the environment (a bare `UNAUTHENTICATED` on sign-up, for example).
 */
export interface ConfigIssue {
  level: ConfigIssueLevel;
  /**
   * Stable machine readable identifier. Deliberately not called `code`: the
   * logger redacts any field whose name contains "code".
   */
  reason: string;
  /** Human readable explanation including the variables to change. */
  message: string;
}

/** Secrets shipped in `.env.example` / used as schema defaults. */
const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-32-byte-random-hex',
  'change-me-too-32-byte-random-hex',
  'dev-only-insecure-secret-change-me',
  'dev-only-insecure-session-secret-change',
]);

/** Anything shorter than this cannot have come from `openssl rand -hex 32`. */
const PRODUCTION_SECRET_MIN_LENGTH = 32;

const FALLBACK_PROVIDERS: Array<{ key: 'DATA_PROVIDER' | 'AUTH_PROVIDER' | 'STORAGE_PROVIDER'; local: string; production: string }> = [
  { key: 'DATA_PROVIDER', local: 'memory', production: 'firestore' },
  { key: 'AUTH_PROVIDER', local: 'dev', production: 'firebase' },
  { key: 'STORAGE_PROVIDER', local: 'memory', production: 'firebase' },
];

/**
 * Whether a private key could plausibly be a service-account key: a PEM block
 * with a base64 body. A real PKCS#8 key is around 1600 base64 characters, which
 * is what separates it from the `key`, `...` and `xxxx` bodies that placeholders
 * and half-pasted values contain.
 */
function privateKeyLooksUsable(privateKey: string): boolean {
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) return false;
  const body = privateKey
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  return body.length >= 100 && /^[A-Za-z0-9+/=]+$/.test(body);
}

/**
 * Pure configuration review: given the parsed environment, list every setting
 * that will break a flow later on. Nothing here throws and nothing here reads
 * `process.env` directly, so the same rules run at boot (server), in tests, and
 * in any future `doctor` command.
 */
export function collectConfigIssues(server: ServerEnv, publicEnv: PublicEnv): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const production = isProduction(server);

  // 1. Firebase Auth on the server, but the browser has no Firebase app to
  //    authenticate against. lib/client/auth-client.ts silently falls back to
  //    the dev client, so no ID token ever reaches the API and every sign-up /
  //    sign-in is rejected with UNAUTHENTICATED ("complete the Firebase
  //    sign-up first"). This is the single most confusing misconfiguration.
  if (server.AUTH_PROVIDER === 'firebase' && !hasFirebaseClientConfig(publicEnv)) {
    issues.push({
      level: 'error',
      reason: 'firebase_auth_without_client_config',
      message:
        'AUTH_PROVIDER=firebase but the Firebase web config is missing (NEXT_PUBLIC_FIREBASE_API_KEY, ' +
        'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID, ' +
        'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, NEXT_PUBLIC_FIREBASE_APP_ID). The browser cannot obtain a ' +
        'Firebase ID token, so registration and login fail with UNAUTHENTICATED ("complete the Firebase sign-up ' +
        'first"). Fill in the NEXT_PUBLIC_FIREBASE_* values, or use AUTH_PROVIDER=dev for local development.',
    });
  }

  // 2. A client and Admin SDK pointed at different projects can create a valid
  // Firebase account whose token the backend can never verify. Catch that
  // deployment error before it presents as a generic registration 401.
  if (
    server.AUTH_PROVIDER === 'firebase' &&
    hasFirebaseClientConfig(publicEnv) &&
    server.FIREBASE_PROJECT_ID &&
    publicEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
    server.FIREBASE_PROJECT_ID !== publicEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  ) {
    issues.push({
      level: 'error',
      reason: 'firebase_project_mismatch',
      message:
        'The Firebase web config and Admin SDK use different projects: NEXT_PUBLIC_FIREBASE_PROJECT_ID must match ' +
        'FIREBASE_PROJECT_ID, otherwise the backend rejects every browser ID token.',
    });
  }

  // 3. Any Firebase-backed provider needs Admin credentials; without them the
  //    first request that touches data/auth/storage throws a 500.
  const needsAdmin =
    server.DATA_PROVIDER === 'firestore' ||
    server.AUTH_PROVIDER === 'firebase' ||
    server.STORAGE_PROVIDER === 'firebase';
  if (needsAdmin && !hasFirebaseAdminCredentials(server)) {
    const selected = [
      server.DATA_PROVIDER === 'firestore' ? 'DATA_PROVIDER=firestore' : null,
      server.AUTH_PROVIDER === 'firebase' ? 'AUTH_PROVIDER=firebase' : null,
      server.STORAGE_PROVIDER === 'firebase' ? 'STORAGE_PROVIDER=firebase' : null,
    ]
      .filter(Boolean)
      .join(', ');
    issues.push({
      level: 'error',
      reason: 'firebase_admin_credentials_missing',
      message:
        `The Firebase Admin SDK credentials are incomplete, but they are needed by ${selected}. ` +
        'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must all be set (blank ' +
        'values count as unset); until then these requests fail with a 500. Add the service account key ' +
        'from Project settings → Service accounts, or use DATA_PROVIDER=memory, AUTH_PROVIDER=dev and ' +
        'STORAGE_PROVIDER=memory for local development.',
    });
  }

  // 3. Credentials that are present but cannot possibly work. A placeholder key
  //    from `.env.example` (or a real one shadowed by a blank/placeholder copy in
  //    a higher-precedence env file) otherwise surfaces as a crypto error from
  //    deep inside the Admin SDK, nowhere near its cause.
  if (server.FIREBASE_PRIVATE_KEY && !privateKeyLooksUsable(server.FIREBASE_PRIVATE_KEY)) {
    issues.push({
      level: 'error',
      reason: 'firebase_private_key_malformed',
      message:
        'FIREBASE_PRIVATE_KEY is set but is not a usable service-account key. Expected the PEM block from ' +
        'Project settings → Service accounts → Generate new private key, on one line with newlines escaped as ' +
        '\\n: "-----BEGIN PRIVATE KEY-----\\n…\\n-----END PRIVATE KEY-----\\n". This is usually the ' +
        '.env.example placeholder left in place, or a placeholder in .env.local shadowing the real key in .env.',
    });
  }
  if (server.FIREBASE_CLIENT_EMAIL && !server.FIREBASE_CLIENT_EMAIL.includes('@')) {
    issues.push({
      level: 'error',
      reason: 'firebase_client_email_malformed',
      message:
        `FIREBASE_CLIENT_EMAIL ("${server.FIREBASE_CLIENT_EMAIL}") is not an email address. It is the ` +
        '`client_email` from the service account key, normally ' +
        'firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com.',
    });
  }

  // 4. Fallback providers in a production build are refused at first use by
  //    assertFallbackAllowed; say so at boot instead of on the first request.
  if (production) {
    for (const provider of FALLBACK_PROVIDERS) {
      if (server[provider.key] === provider.local) {
        issues.push({
          level: 'error',
          reason: 'fallback_provider_in_production',
          message:
            `${provider.key}=${provider.local} is refused in a production build (NODE_ENV=production and ` +
            `APP_ENV=production). Set ${provider.key}=${provider.production} and configure Firebase.`,
        });
      }
    }
  }

  // 5. Placeholder / short signing secrets. Fatal in production, worth a nudge
  //    anywhere else because sessions signed with a published secret are forgeable.
  for (const key of ['APP_SECRET', 'DEV_SESSION_SECRET'] as const) {
    const value = server[key];
    if (PLACEHOLDER_SECRETS.has(value)) {
      issues.push({
        level: production ? 'error' : 'warn',
        reason: 'placeholder_secret',
        message:
          `${key} is still the placeholder from .env.example. Anyone who has read the repository can forge ` +
          'access sessions and challenge tokens with it. Generate one with `openssl rand -hex 32`.',
      });
    } else if (production && value.length < PRODUCTION_SECRET_MIN_LENGTH) {
      issues.push({
        level: 'error',
        reason: 'weak_secret',
        message: `${key} is shorter than ${PRODUCTION_SECRET_MIN_LENGTH} characters, which is too weak for production.`,
      });
    }
  }

  return issues;
}

/** Convenience wrapper around the raw `process.env`, for boot-time checks. */
export function collectConfigIssuesFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigIssue[] {
  return collectConfigIssues(parseServerEnv(env), parsePublicEnv(env));
}

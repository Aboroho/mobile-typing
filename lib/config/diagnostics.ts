import { parsePublicEnv, hasFirebaseClientConfig, type PublicEnv } from './public-env';
import { hasFirebaseAdminCredentials, isProduction, parseServerEnv, type ServerEnv } from './server-env';

export type ConfigIssueLevel = 'error' | 'warn' | 'info';

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
  'dev-only-insecure-secret-change-me',
]);

/** Anything shorter than this cannot have come from `openssl rand -hex 32`. */
const PRODUCTION_SECRET_MIN_LENGTH = 32;

/**
 * Providers that may fall back to a local implementation outside production.
 * Authentication is not in this list: it has no fallback, Firebase is required.
 */
const FALLBACK_PROVIDERS: Array<{ key: 'DATA_PROVIDER' | 'STORAGE_PROVIDER'; local: string; production: string }> = [
  { key: 'DATA_PROVIDER', local: 'memory', production: 'firestore' },
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

  // 1. Authentication is Firebase Authentication, so without the web config the
  //    browser has no Firebase app to authenticate against: no ID token ever
  //    reaches the API and every sign-up / sign-in is rejected with
  //    UNAUTHENTICATED. This is the single most confusing misconfiguration, and
  //    it is now unconditional — there is no provider switch to fall back on.
  //    When the Auth emulator is configured the same five keys must still be set
  //    (they can be any non-empty values; the emulator does not validate them).
  const emulatorHost =
    (publicEnv as unknown as Record<string, unknown>).NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ??
    (server as unknown as Record<string, unknown>).FIREBASE_AUTH_EMULATOR_HOST ??
    (server as unknown as Record<string, unknown>).NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  const usingEmulator =
    typeof emulatorHost === 'string' && String(emulatorHost).trim().length > 0;

  if (!hasFirebaseClientConfig(publicEnv)) {
    if (usingEmulator) {
      issues.push({
        level: 'warn',
        reason: 'firebase_auth_emulator_without_client_config',
        message:
          'FIREBASE_AUTH_EMULATOR_HOST is set but the Firebase web configuration is still incomplete. ' +
          'When using the Auth emulator NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, ' +
          'NEXT_PUBLIC_FIREBASE_PROJECT_ID, NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID and ' +
          'NEXT_PUBLIC_FIREBASE_APP_ID must all be set — they can be any values (e.g. demo-*), but empty ' +
          'values still count as unset. Fill them in .env.local or unset the emulator host.',
      });
    } else {
      issues.push({
        level: 'error',
        reason: 'firebase_auth_without_client_config',
        message:
          'Firebase Authentication is not configured. Set NEXT_PUBLIC_FIREBASE_API_KEY, ' +
          'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID, ' +
          'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID and NEXT_PUBLIC_FIREBASE_APP_ID ' +
          '(Firebase console → Project settings → Your apps → SDK setup and configuration), ' +
          'then restart the dev server so the browser bundle picks the values up. ' +
          'Until then registration and login fail with UNAUTHENTICATED ("complete the Firebase sign-up first"). ' +
          'For local development without a Firebase project, set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 ' +
          'and NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 and run the Auth emulator (npm run emulator).',
      });
    }
  } else if (usingEmulator) {
    issues.push({
      level: 'info',
      reason: 'firebase_auth_using_emulator',
      message: `Firebase Auth emulator is enabled via ${emulatorHost}. The client and Admin SDKs will talk to the local emulator instead of production. Do not use this in production.`,
    });
  }

  // 2. A client and Admin SDK pointed at different projects can create a valid
  //    Firebase account whose token the backend can never verify. Catch that
  //    deployment error before it presents as a generic registration 401.
  if (
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

  // 3. Verifying a Firebase credential needs the Admin SDK, so the service
  //    account is required by every deployment; data and storage add to that.
  //    When the Auth emulator is in use the Admin SDK can run without real
  //    service-account credentials (it talks to the local emulator).
  if (!hasFirebaseAdminCredentials(server) && !usingEmulator) {
    const selected = [
      'Firebase Authentication',
      server.DATA_PROVIDER === 'firestore' ? 'DATA_PROVIDER=firestore' : null,
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
        'values count as unset); until then no ID token or session cookie can be verified and these requests ' +
        'fail with a 500. Add the service account key from Project settings → Service accounts → Generate new ' +
        'private key, with newlines escaped as \\n on a single line. For local development without a project, ' +
        'set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 and NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 instead.',
    });
  }

  // 4. Credentials that are present but cannot possibly work. A placeholder key
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

  // 5. Fallback providers in a production build are refused at first use by
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

  // 6. Placeholder / short signing secrets. Fatal in production, worth a nudge
  //    anywhere else because sessions signed with a published secret are forgeable.
  for (const key of ['APP_SECRET'] as const) {
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

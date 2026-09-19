import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { parsePublicEnv } from '@mt/config';
import { env } from '../env';
import { logger } from '../logger';

let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;

/**
 * Lazily initialises the Firebase Admin SDK. Credentials come only from
 * server-side environment variables — never from `NEXT_PUBLIC_*`. The Admin SDK
 * bypasses security rules, which is exactly why every service performs its own
 * authorisation checks before touching data.
 */
export function getAdminApp(): App {
  if (cachedApp) return cachedApp;
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_AUTH_EMULATOR_HOST,
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST,
  } = env() as unknown as Record<string, string | undefined>;
  const emulatorHost = FIREBASE_AUTH_EMULATOR_HOST ?? NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  const usingEmulator = typeof emulatorHost === 'string' && emulatorHost.trim().length > 0;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    if (usingEmulator) {
      // For the emulator we can initialise with dummy credentials; the SDK will
      // route Auth calls to the emulator instead of attempting a real JWT grant.
      const projectId = FIREBASE_PROJECT_ID ?? 'demo-project';
      if (!process.env.FIREBASE_AUTH_EMULATOR_HOST && emulatorHost) {
        process.env.FIREBASE_AUTH_EMULATOR_HOST = emulatorHost;
      }
      cachedApp =
        getApps().find((app) => app.name === 'mt') ??
        initializeApp({ projectId }, 'mt');
      logger.debug('firebase.admin.initialised.emulator', { projectId, emulatorHost });
      return cachedApp;
    }
    throw new Error(
      'Firebase Admin credentials are missing. Set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, or set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 ' +
        'for local development with the Auth emulator.',
    );
  }
  if (emulatorHost && !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = emulatorHost;
  }
  cachedApp =
    getApps().find((app) => app.name === 'mt') ??
    initializeApp(
      {
        credential: cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY,
        }),
        projectId: FIREBASE_PROJECT_ID,
      },
      'mt',
    );
  logger.debug('firebase.admin.initialised', { projectId: FIREBASE_PROJECT_ID, emulatorHost: emulatorHost ?? null });
  return cachedApp;
}

export function getFirestoreDb(): Firestore {
  if (cachedDb) return cachedDb;
  cachedDb = getFirestore(getAdminApp());
  return cachedDb;
}

/**
 * Resolves the bucket to use for media.
 *
 * The configured web-SDK bucket wins: projects created since Cloud Storage's
 * 2024 default-bucket change are named `<project-id>.firebasestorage.app`, so
 * deriving `<project-id>.appspot.com` from the project id alone targets a
 * bucket that does not exist and every upload fails. The `appspot.com` shape is
 * kept as the fallback for older projects, and `undefined` lets the SDK use its
 * own default (application-default credentials / emulator).
 */
export function resolveStorageBucketName(
  projectId: string | undefined,
  configuredBucket: string | undefined,
): string | undefined {
  const configured = configuredBucket?.trim();
  if (configured) return configured;
  const id = projectId?.trim();
  return id ? `${id}.appspot.com` : undefined;
}

export function getStorageBucket() {
  const { FIREBASE_PROJECT_ID } = env();
  const name = resolveStorageBucketName(FIREBASE_PROJECT_ID, publicStorageBucket());
  return name ? getStorage().bucket(name) : getStorage().bucket();
}

/**
 * The bucket from the Firebase web config, if any. Read defensively: this is a
 * `NEXT_PUBLIC_*` value parsed by a schema that can throw, and a storage call is
 * the wrong place to surface an environment error.
 */
function publicStorageBucket(): string | undefined {
  try {
    return parsePublicEnv().NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  } catch {
    return undefined;
  }
}

export function getAdminAuth() {
  return getAuth(getAdminApp());
}

/** Test helper. */
export function resetAdminCache(): void {
  cachedApp = null;
  cachedDb = null;
}

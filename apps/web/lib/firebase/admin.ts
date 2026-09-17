import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
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
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = env();
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      'Firebase Admin credentials are missing. Set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, or use the memory providers for local development.',
    );
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
  logger.debug('firebase.admin.initialised', { projectId: FIREBASE_PROJECT_ID });
  return cachedApp;
}

export function getFirestoreDb(): Firestore {
  if (cachedDb) return cachedDb;
  cachedDb = getFirestore(getAdminApp());
  return cachedDb;
}

export function getStorageBucket() {
  const { FIREBASE_PROJECT_ID } = env();
  return FIREBASE_PROJECT_ID
    ? getStorage().bucket(`${FIREBASE_PROJECT_ID}.appspot.com`)
    : getStorage().bucket();
}

export function getAdminAuth() {
  return getAuth(getAdminApp());
}

/** Test helper. */
export function resetAdminCache(): void {
  cachedApp = null;
  cachedDb = null;
}

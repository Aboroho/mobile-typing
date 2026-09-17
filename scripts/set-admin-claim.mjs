#!/usr/bin/env node
/**
 * Grants the `role: 'admin'` custom claim that firestore.rules checks.
 *
 *   ADMIN_UID=xxxxxxxx node scripts/set-admin-claim.mjs
 *
 * Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.
 */
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const uid = process.env.ADMIN_UID;
if (!uid) {
  console.error('Set ADMIN_UID to the uid that should become the administrator.');
  process.exit(1);
}
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
  console.error('Missing Firebase Admin credentials in the environment.');
  process.exit(1);
}

const app =
  getApps()[0] ??
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });

const user = await getAuth(app).getUser(uid);
await getAuth(app).setCustomUserClaims(uid, { role: 'admin' });
console.log(`role=admin set for ${user.email ?? uid}`);
console.log('The user must sign out and back in for the new claim to appear in their token.');

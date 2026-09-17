#!/usr/bin/env node
/**
 * Seeds `appConfig/access` in a real Firestore project.
 *
 * Normally this is unnecessary — the first request to `POST /api/v1/access/challenge`
 * bootstraps the document from `SEED_SECRET_CODE`. Use this script when you want
 * the code configured *before* the app is reachable (for example as part of a
 * deployment pipeline), or when you want to set the epoch deliberately.
 *
 *   FIREBASE_PROJECT_ID=… FIREBASE_CLIENT_EMAIL=… FIREBASE_PRIVATE_KEY=… \
 *   SEED_SECRET_CODE=mySecret1 node firebase/seed/seed-access-config.mjs
 *
 * The plaintext code is never printed: only a fingerprint of its salted digest.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const SECRET_CODE_MAX_LENGTH = 15;
// SEED_SECRET_CODE matches the key the application bootstraps from; SECRET_CODE
// is still accepted as the legacy spelling.
const code = process.env.SEED_SECRET_CODE ?? process.env.SECRET_CODE;
const epoch = Number(process.env.ACCESS_EPOCH ?? 1);

if (!code || code.length < 3 || code.length > SECRET_CODE_MAX_LENGTH || /\s/.test(code)) {
  console.error(`SEED_SECRET_CODE must be 3-${SECRET_CODE_MAX_LENGTH} characters without whitespace.`);
  process.exit(1);
}
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
  console.error('Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY.');
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

const db = getFirestore(app);
const ref = db.collection('appConfig').doc('access');
const existing = await ref.get();

const salt = existing.data()?.salt ?? randomBytes(16).toString('hex');
const now = new Date().toISOString();
const document = {
  code,
  digest: createHash('sha256').update(code).digest('hex'),
  salt,
  maxLength: SECRET_CODE_MAX_LENGTH,
  caseSensitive: true,
  // Bumping the epoch invalidates every outstanding challenge and session.
  epoch: existing.exists && process.env.ACCESS_EPOCH === undefined ? (existing.data().epoch ?? 1) : epoch,
  unlockCount: existing.data()?.unlockCount ?? 0,
  updatedBy: 'seed-script',
  updatedAt: now,
  createdAt: existing.data()?.createdAt ?? now,
};

await ref.set(document);

const fingerprint = createHmac('sha256', salt).update(code).digest('hex').slice(0, 8);
console.log(`appConfig/access written for ${process.env.FIREBASE_PROJECT_ID}`);
console.log(`  epoch=${document.epoch} maxLength=${document.maxLength} fingerprint=${fingerprint}`);
console.log('The plaintext code was not printed and is not stored anywhere else.');

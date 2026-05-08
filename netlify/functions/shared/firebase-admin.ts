// Firebase Admin singleton for Netlify functions.
//
// Backend-only — uses a service account to bypass Firestore security rules.
// Distinct from the frontend src/firebase.js which uses the public Web SDK.
//
// Required env var:
//   FIREBASE_SERVICE_ACCOUNT — full service-account JSON for the
//   tradeiq-alpha Firebase project (project number 101124117025).
//   Generate via Firebase Console → Project settings → Service accounts →
//   "Generate new private key", then paste the entire JSON as the env var
//   value on Netlify (Site settings → Environment variables).
//
// Phase 1 caller pattern:
//   import { getAdminDb } from './shared/firebase-admin';
//   const db = getAdminDb();
//   await db.collection('boardSnapshots').doc(...).set(...);

import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let _app: App | null = null;
let _db: Firestore | null = null;

export function getAdminDb(): Firestore {
  if (_db) return _db;

  if (!getApps().length) {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!sa) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT env var not set. ' +
          'Generate a service-account JSON from Firebase Console for the ' +
          'tradeiq-alpha project and set the full JSON as the Netlify env var.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(sa);
    } catch (e) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT is not valid JSON. ' +
          'Paste the full JSON from Firebase Console (no quoting/escaping).',
      );
    }
    _app = initializeApp({ credential: cert(parsed as Parameters<typeof cert>[0]) });
  }

  _db = getFirestore();
  return _db;
}

// Exposed for tests / smoke checks; do not use in scan code.
export function _resetAdminForTest(): void {
  _app = null;
  _db = null;
}

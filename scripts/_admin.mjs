/**
 * Shared bootstrap for the local admin scripts (`seed`, `create-admin`).
 *
 * These act as the project, not as a user: they write documents the security
 * rules forbid every client — `church-attendance-admins` is `allow write: if
 * false` precisely so a compromised admin session can't mint more admins. Only
 * the Admin SDK can do that, and the service-account key is what buys the
 * bypass. Your VITE_FIREBASE_* config can't: it names the project, it doesn't
 * prove you own it.
 *
 * Same FIREBASE_SERVICE_ACCOUNT the Netlify functions use — one secret, one
 * name, and the project id is read out of the key rather than configured twice.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// These scripts don't go through Vite, so nothing has loaded `.env` for them.
// Node reads it natively, and leaves any existing shell variable in place.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env — fine, the variables may come from the shell instead.
}

const { loadServiceAccount } = await import('../netlify/lib/service-account.mjs');

let projectId;

try {
  const key = loadServiceAccount();
  projectId = key.project_id;
  initializeApp({ credential: cert(key), projectId });
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

export const db = getFirestore();
export const auth = getAuth();
export const target = projectId;

/**
 * There is no emulator: every run touches real data. Say so loudly, with the
 * project name, so a wrong key is caught before it writes.
 */
export function confirmLive() {
  console.log(`\n⚠️  Writing to LIVE project "${projectId}".`);
}

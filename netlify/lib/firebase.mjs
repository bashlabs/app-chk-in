/**
 * Firebase Admin bootstrap for the Netlify functions.
 *
 * On Cloud Functions this was free — the runtime injected credentials. Off
 * Firebase we supply them ourselves; see `./service-account.mjs` for where the
 * key comes from and why the client config can't do this job.
 */
import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { loadServiceAccount } from './service-account.mjs';

function options() {
  const key = loadServiceAccount();
  // The key names its own project, so there's nothing else to configure.
  return { credential: cert(key), projectId: key.project_id };
}

// Netlify reuses a warm instance across invocations, so guard the re-init.
const app = getApps().length ? getApp() : initializeApp(options());

export const db = getFirestore(app);

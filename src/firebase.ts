/**
 * The Firebase *client* SDK — browser-side, used only by the admin screens.
 *
 * Not to be confused with `netlify/lib/firebase.mjs`, which is the Firebase
 * *Admin* SDK. That one runs on the server, holds the service-account key and
 * bypasses security rules. This one runs in the browser with public config and
 * is subject to them. The two must never converge: the service-account key in a
 * browser bundle would hand anyone read/write on the whole database.
 *
 * These values authenticate nothing — they name the project so requests route
 * to it. Authorisation comes from the admin's sign-in token plus the rules.
 *
 * The public check-in page imports none of this — it calls our own `/api/*`
 * (see `src/lib/api.ts`). Keeping it that way is what holds the Firestore and
 * Auth SDKs (~570 kB) out of the bundle the congregation downloads, so import
 * this only from lazily-loaded admin code.
 */
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

const env = import.meta.env;

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);

// `npm run dev:emulator` sets this so the admin screens work against the local
// emulator instead of the real congregation data — editing and removing members
// are destructive, and there was no way to rehearse them safely.
//
// Vite inlines the literal at build time, so a production bundle contains
// `if (false)` and drops the branch entirely.
if (import.meta.env.VITE_USE_EMULATORS === 'true') {
  connectAuthEmulator(auth, `http://localhost:${env.VITE_AUTH_EMULATOR_PORT ?? 9099}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(db, 'localhost', Number(env.VITE_FIRESTORE_EMULATOR_PORT ?? 8088));
}

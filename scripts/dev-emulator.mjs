/**
 * `npm run dev:emulator` — the dev server, pointed at the Firestore emulator.
 *
 *   npm run dev            # talks to the REAL church database
 *   npm run dev:emulator   # talks to a throwaway local one
 *
 * Plain `npm run dev` reads FIREBASE_SERVICE_ACCOUNT from `.env`, so every
 * check-in you try while developing writes a real attendance row into the
 * congregation's data. This runs the same handlers against an in-memory
 * Firestore instead, seeded with a few members you can actually test with.
 *
 * Launched through `firebase emulators:exec`, which sets FIRESTORE_EMULATOR_HOST
 * and keeps the emulator alive until Vite exits. Refuses to run without it, so
 * it can never point at production.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import process from 'node:process';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    'Refusing to run: FIRESTORE_EMULATOR_HOST is not set.\n' +
      'This guard is what keeps the dev server off the real church database.\n\n' +
      'Use the npm script, which wraps this in the emulator:\n' +
      '  npm run dev:emulator',
  );
  process.exit(1);
}

// firebase.mjs builds cert(loadServiceAccount()) at import time and
// firebase-admin parses the private key there, so it must be a real PEM. Under
// the emulator it never signs anything, so a throwaway keypair satisfies the
// parser and stays on this machine. Set unconditionally: a real key in `.env`
// must not win here, or the seed below would run against production.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(
  JSON.stringify({
    project_id: process.env.GCLOUD_PROJECT || 'demo-attendance',
    client_email: 'dev@demo-attendance.iam.gserviceaccount.com',
    private_key: privateKey,
  }),
).toString('base64');
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const { db } = await import('../netlify/lib/firebase.mjs');
const { getAuth } = await import('firebase-admin/auth');
const { COLLECTIONS, ACCESS_CONFIG_DOC } = await import('../shared/collections.js');
const { normalizePhone, memberDocId } = await import('../shared/identity.js');

// 'open' ignores the day-of-week gate, so the app is testable on a Tuesday.
await db.doc(ACCESS_CONFIG_DOC).set(
  {
    mode: 'open',
    timezone: 'Africa/Lagos',
    successMessage: 'Thanks for coming to church today.',
    unknownMessage: "We couldn't find your record.",
    closedMessage: 'Check-in is closed right now.',
  },
  { merge: true },
);

// Two members, deliberately mirroring the live mix: one clean, and one pair
// where the name on file is the one the 21 July import got wrong.
const seed = [
  { name: 'Ada Obi', phone: '08031234567' },
  { name: 'Elena', phone: '07032320577' },
];
for (const person of seed) {
  const phoneE164 = normalizePhone(person.phone);
  await db.doc(`${COLLECTIONS.members}/${memberDocId({ type: 'phone', value: phoneE164 })}`).set(
    { name: person.name, email: null, emailLower: null, phone: person.phone, phoneE164, createdAt: new Date() },
    { merge: true },
  );
}

// A couple of past Sundays for Ada, so an edit that re-keys her document has
// attendance to move — the case worth rehearsing before doing it for real.
for (const date of ['2026-07-19', '2026-07-26']) {
  const id = memberDocId({ type: 'phone', value: '+2348031234567' });
  await db.doc(`${COLLECTIONS.attendance}/${date}_${id}`).set({
    memberId: id,
    name: 'Ada Obi',
    serviceDate: date,
    checkedInAt: new Date(`${date}T08:30:00Z`),
    via: 'phone',
  });
}

// An admin to sign in as. The Auth emulator accepts any password for a user it
// knows about, and none of this leaves the machine.
const ADMIN = { email: 'admin@example.com', password: 'password' };
const auth = getAuth();
const user = await auth
  .createUser({ email: ADMIN.email, password: ADMIN.password })
  .catch(() => auth.getUserByEmail(ADMIN.email));
await db.doc(`${COLLECTIONS.admins}/${user.uid}`).set({ email: ADMIN.email });

// Read by src/firebase.ts, which is what points the admin screens at the
// emulator rather than the real project.
process.env.VITE_USE_EMULATORS = 'true';
// The emulator namespaces data by project id, so the browser has to name the
// same project the seed above wrote to — otherwise the admin screens connect
// happily and read an empty parallel database. Vite gives a real environment
// variable priority over `.env`, so this wins over VITE_FIREBASE_PROJECT_ID.
process.env.VITE_FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-attendance';
process.env.VITE_FIRESTORE_EMULATOR_PORT = String(new URL(`http://${process.env.FIRESTORE_EMULATOR_HOST}`).port);
process.env.VITE_AUTH_EMULATOR_PORT = String(
  new URL(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? 'localhost:9099'}`).port,
);

console.log(`\nSeeded the emulator with ${seed.length} members:`);
for (const p of seed) console.log(`   ${p.phone}  ${p.name}`);
console.log('   (any other number is "not found", which is the registration path)');
console.log(`\nAdmin sign-in:  ${ADMIN.email}  /  ${ADMIN.password}\n`);

// A port of its own, so this can run alongside a plain `npm run dev` (5173)
// without either stealing the other's.
const vite = spawn('npx', ['vite', '--port', process.env.PORT || '5174', '--strictPort', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
vite.on('exit', (code) => process.exit(code ?? 0));

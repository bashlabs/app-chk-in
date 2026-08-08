/**
 * Shared harness for the integration tests.
 *
 * These drive the REAL Netlify handlers in-process against the Firestore
 * emulator, so they exercise the actual query, the actual transaction and the
 * actual document ids — the things unit tests over `shared/identity.js` can't
 * reach, and where every bug this app has had actually lived.
 *
 * Run them with `npm run test:integration`, which wraps this in
 * `firebase emulators:exec`. They refuse to start without the emulator, so they
 * can never touch the real church database.
 */
import { generateKeyPairSync } from 'node:crypto';
import process from 'node:process';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    'Refusing to run: FIRESTORE_EMULATOR_HOST is not set.\n' +
      'This guard is what keeps the integration tests off the real church database.\n\n' +
      '  npm run test:integration',
  );
  process.exit(1);
}

// firebase.mjs parses the private key at import time, so it must be a real PEM.
// Under the emulator it never signs anything. Set unconditionally so a real key
// in `.env` can't win and point the suite at production.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(
  JSON.stringify({
    project_id: process.env.GCLOUD_PROJECT || 'demo-attendance',
    client_email: 'tests@demo-attendance.iam.gserviceaccount.com',
    private_key: privateKey,
  }),
).toString('base64');
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

// No config caching: several tests open and close the window inside one run.
process.env.CONFIG_CACHE_MS = '0';
// Small enough to reach a limit without firing hundreds of requests. Read at
// module load inside http.mjs, so it has to be set before the import below.
process.env.RATE_LIMIT_MAX_FAILURES ??= '5';
process.env.PUBLIC_WRITE_MAX ??= '3';
// reCAPTCHA verification is skipped when no secret is configured.
delete process.env.RECAPTCHA_SECRET_KEY;

export const { db } = await import('../../netlify/lib/firebase.mjs');
export const { COLLECTIONS, ACCESS_CONFIG_DOC } = await import('../../shared/collections.js');
export const { memberDocId } = await import('../../shared/identity.js');

export const { default: checkIn } = await import('../../netlify/functions/check-in.mjs');
export const { default: register } = await import('../../netlify/functions/register.mjs');
export const { default: dispute } = await import('../../netlify/functions/dispute.mjs');

/** Call a handler the way Netlify would, and hand back status + parsed body. */
export async function call(handler, body, { ip = '10.0.0.1' } = {}) {
  const req = new Request('http://local/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await handler(req, { ip });
  return { status: res.status, body: await res.json() };
}

async function wipe(name) {
  const snap = await db.collection(name).get();
  // The emulator has no bulk delete; these collections stay tiny in tests.
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

/** Empty every collection the handlers touch. Call in beforeEach. */
export async function reset() {
  await Promise.all([
    wipe(COLLECTIONS.members),
    wipe(COLLECTIONS.attendance),
    wipe(COLLECTIONS.rateLimits),
    wipe(COLLECTIONS.disputes),
  ]);
}

/** Force the check-in window open (or shut) regardless of the day. */
export async function setWindow(open) {
  await db.doc(ACCESS_CONFIG_DOC).set(
    {
      // Only 'schedule' | 'open' | 'closed' survive resolveConfig(); anything
      // else is silently rewritten to the default, which on a Sunday is open.
      mode: open ? 'open' : 'closed',
      timezone: 'Africa/Lagos',
      successMessage: 'Thanks for coming.',
      unknownMessage: 'No record found.',
      closedMessage: 'Check-in is closed.',
    },
    { merge: true },
  );
}

/** Put a member on file the way the migration script did. */
export async function seedMember({ name, phone, email = null }) {
  const identity = phone
    ? { type: 'phone', value: phone }
    : { type: 'email', value: email };
  const id = memberDocId(identity);
  await db.doc(`${COLLECTIONS.members}/${id}`).set({
    name,
    email,
    emailLower: email,
    phone,
    phoneE164: phone,
    createdAt: new Date(),
  });
  return id;
}

export const count = async (name) => (await db.collection(name).get()).size;
export const docsOf = async (name) => (await db.collection(name).get()).docs;
export const today = () => new Date().toISOString().slice(0, 10);

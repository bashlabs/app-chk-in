/**
 * Creates an admin: the Firebase Auth account (if missing) plus the
 * `church-attendance-admins/{uid}` document the rules check.
 *
 *   npm run create-admin -- you@church.ng                 # generates a password
 *   npm run create-admin -- you@church.ng 'your-password' # or pick your own
 *
 * Credentials come from FIREBASE_SERVICE_ACCOUNT in `.env`.
 *
 * Safe to re-run: an existing account is granted admin, not overwritten, and
 * its password is left alone.
 *
 * There is deliberately no "make admin" button in the app — granting stays out
 * of band so a compromised admin session can't mint more admins. Revoke by
 * deleting the admins document.
 */
import { randomBytes } from 'node:crypto';

import { db, auth, confirmLive, target } from './_admin.mjs';
import { COLLECTIONS } from '../shared/collections.js';

const [email, givenPassword] = process.argv.slice(2);

if (!email || !email.includes('@')) {
  console.error('Usage: npm run create-admin -- <email> [password]');
  process.exit(1);
}

/** Readable but high-entropy: ~128 bits, no ambiguous characters. */
function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(22)].map((b) => alphabet[b % alphabet.length]).join('');
}

if (givenPassword && givenPassword.length < 6) {
  console.error('Firebase requires a password of at least 6 characters.');
  process.exit(1);
}

confirmLive();

let user;
let password = null;

try {
  user = await auth.getUserByEmail(email);
  console.log(`• Account already exists (${user.uid}) — leaving its password alone.`);
} catch (err) {
  if (err.code !== 'auth/user-not-found') throw err;

  password = givenPassword ?? generatePassword();
  user = await auth.createUser({ email, password });
  console.log(`✓ Created Firebase Auth account for ${email}`);
}

await db.doc(`${COLLECTIONS.admins}/${user.uid}`).set(
  { email: user.email, grantedAt: new Date() },
  { merge: true },
);

console.log(`✓ ${email} is now an admin on ${target}`);

if (password && !givenPassword) {
  console.log(`\n  Password: ${password}`);
  console.log('  Save it now — it is not stored anywhere and cannot be shown again.');
  console.log('  Change it later via the Firebase console → Authentication → Users.');
}

console.log('\nSign in at /admin.');
process.exit(0);

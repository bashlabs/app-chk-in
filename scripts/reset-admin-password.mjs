/**
 * Resets (or sets) an admin's password and guarantees their admin record.
 *
 *   node scripts/reset-admin-password.mjs <email>
 *
 * The new password is read from the NEW_ADMIN_PASSWORD environment variable —
 * NEVER passed on the command line or in chat, so it stays out of shell history
 * and this transcript. Put it in `.env` alongside a valid FIREBASE_SERVICE_ACCOUNT:
 *
 *   FIREBASE_SERVICE_ACCOUNT=<base64 of a service-account key>
 *   NEW_ADMIN_PASSWORD='the-new-password'
 *
 * If the account doesn't exist yet it's created; if it does, only its password
 * changes. Either way the church-attendance-admins/{uid} doc is ensured, so the
 * account can actually get past the admin gate. Delete NEW_ADMIN_PASSWORD from
 * .env once this has run.
 */
import { db, auth, confirmLive, target } from './_admin.mjs';
import { COLLECTIONS } from '../shared/collections.js';

const email = process.argv[2];
const password = process.env.NEW_ADMIN_PASSWORD;

if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/reset-admin-password.mjs <email>   (with NEW_ADMIN_PASSWORD set in .env)');
  process.exit(1);
}
if (!password) {
  console.error('NEW_ADMIN_PASSWORD is not set. Add it to .env (do not put it on the command line).');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Firebase requires a password of at least 6 characters.');
  process.exit(1);
}

confirmLive();

let user;
try {
  user = await auth.getUserByEmail(email);
  await auth.updateUser(user.uid, { password });
  console.log(`✓ Password reset for existing account ${email} (${user.uid}).`);
} catch (err) {
  if (err.code !== 'auth/user-not-found') throw err;
  user = await auth.createUser({ email, password });
  console.log(`✓ No account existed — created ${email} (${user.uid}).`);
}

const adminRef = db.doc(`${COLLECTIONS.admins}/${user.uid}`);
const existed = (await adminRef.get()).exists;
await adminRef.set({ email: user.email, grantedAt: new Date() }, { merge: true });
console.log(existed ? '✓ Admin record already present.' : '✓ Admin record created.');

console.log(`\nDone on "${target}". Sign in at /admin with ${email} and your new password.`);
console.log('Now delete NEW_ADMIN_PASSWORD from .env.');
process.exit(0);

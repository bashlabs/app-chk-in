/**
 * One-off migration: import cleaned members from a JSON file into the members
 * collection, in preparation for a service.
 *
 *   node scripts/migrate-members.mjs --input <members.json>            # preview (dry run)
 *   node scripts/migrate-members.mjs --input <members.json> --commit   # actually write
 *
 * Input: a JSON array of { name, phoneE164 } (extra fields ignored). Every row
 * is re-validated against shared/identity.js here, so a hand-edited file can't
 * slip a bad phone into the database.
 *
 * Credentials come from the same FIREBASE_SERVICE_ACCOUNT / .env the other admin
 * scripts use (see _admin.mjs). Safe to re-run: members are keyed by a
 * deterministic id (the phone digits) and anyone whose phone is already on file
 * is skipped, so nothing is ever duplicated.
 */
import { readFileSync } from 'node:fs';

import { db, confirmLive, target } from './_admin.mjs';
import { COLLECTIONS } from '../shared/collections.js';
import { normalizePhone } from '../shared/identity.js';

const argv = process.argv.slice(2);
const commit = argv.includes('--commit');
const input = argv[argv.indexOf('--input') + 1];

if (argv.indexOf('--input') === -1 || !input) {
  console.error('Usage: node scripts/migrate-members.mjs --input <members.json> [--commit]');
  process.exit(1);
}

let incoming;
try {
  incoming = JSON.parse(readFileSync(input, 'utf8'));
} catch (err) {
  console.error(`Could not read/parse ${input}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(incoming)) {
  console.error('Input must be a JSON array.');
  process.exit(1);
}

confirmLive();
console.log(`Input: ${input}  (${incoming.length} records)\n`);

// Re-normalise every row against the shared rules — never trust the file.
const clean = [];
let bad = 0;
for (const m of incoming) {
  const name = typeof m?.name === 'string' ? m.name.trim() : '';
  const phoneE164 = normalizePhone(m?.phoneE164 ?? m?.phone);
  if (!name || !phoneE164) {
    bad++;
    continue;
  }
  clean.push({ name, phoneE164 });
}
if (bad) console.log(`⚠  ${bad} record(s) skipped — missing name or invalid phone.`);

// Skip anyone whose phone is already on file. This makes the run idempotent and
// avoids duplicating members added earlier through the UI (which use random ids).
const snap = await db.collection(COLLECTIONS.members).get();
const existing = new Set();
snap.forEach((d) => {
  const p = d.get('phoneE164');
  if (p) existing.add(p);
});
console.log(`Already in "${target}": ${snap.size} members (${existing.size} with a phone)\n`);

const toCreate = [];
let already = 0;
const seen = new Set();
for (const m of clean) {
  if (existing.has(m.phoneE164) || seen.has(m.phoneE164)) {
    already++;
    continue;
  }
  seen.add(m.phoneE164);
  toCreate.push(m);
}

console.log(`Plan: create ${toCreate.length}, skip ${already} already present.`);

if (!commit) {
  console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
  console.log('First 10 that would be created:');
  for (const m of toCreate.slice(0, 10)) console.log(`   ${m.name}  ${m.phoneE164}`);
  process.exit(0);
}

// Firestore caps a batch at 500 writes.
let written = 0;
for (let i = 0; i < toCreate.length; i += 400) {
  const batch = db.batch();
  for (const m of toCreate.slice(i, i + 400)) {
    const id = m.phoneE164.replace(/\D/g, ''); // deterministic → re-run safe
    batch.set(
      db.doc(`${COLLECTIONS.members}/${id}`),
      {
        name: m.name,
        email: null,
        emailLower: null,
        phone: m.phoneE164,
        phoneE164: m.phoneE164,
        createdAt: new Date(),
      },
      { merge: true },
    );
  }
  await batch.commit();
  written += Math.min(400, toCreate.length - i);
  console.log(`  committed ${written}/${toCreate.length}`);
}

console.log(`\n✓ Done. Created/updated ${written} members on "${target}".`);
process.exit(0);

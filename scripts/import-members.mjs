/**
 * Replace the congregation directory with a roster exported from the office
 * spreadsheet.
 *
 *   node scripts/import-members.mjs --input <members.json>            # preview (dry run)
 *   node scripts/import-members.mjs --input <members.json> --commit   # actually write
 *
 * Unlike `migrate-members.mjs`, which adds to what is already there, this one
 * makes the file authoritative: every existing member document is deleted first,
 * so anyone the spreadsheet has dropped stops being on file. Take a backup.
 *
 * Input: a JSON array of { name, phone|phoneE164, email? }. Every row is
 * re-validated against shared/identity.js here — a hand-edited file cannot slip
 * a bad number past this, and a row that fails is reported rather than skipped
 * quietly.
 *
 * The hashed-IP throttle counters go too. They are keyed to the old directory
 * and there is no reason a new roster should inherit anyone's rate-limit debt.
 *
 * Attendance, admins and the access config are deliberately left alone. Member
 * ids are derived from the phone number (see `memberDocId`), so a member who
 * appears in both the old directory and the new file keeps the same id and their
 * check-in history stays attached; the script reports any history that does get
 * orphaned rather than silently breaking it.
 *
 * Credentials come from the same FIREBASE_SERVICE_ACCOUNT / .env the other admin
 * scripts use (see _admin.mjs).
 */
import { readFileSync } from 'node:fs';

import { db, confirmLive, target } from './_admin.mjs';
import { COLLECTIONS } from '../shared/collections.js';
import { normalizePhone, normalizeEmail, normalizeName, memberDocId } from '../shared/identity.js';

const argv = process.argv.slice(2);
const commit = argv.includes('--commit');
const input = argv[argv.indexOf('--input') + 1];

if (argv.indexOf('--input') === -1 || !input) {
  console.error('Usage: node scripts/import-members.mjs --input <members.json> [--commit]');
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

// ------------------------------------------------------------- validate input
// Nothing is deleted until the whole file has passed, so a bad row can never
// leave the directory empty.
const byId = new Map();
const rejected = [];

for (const [i, m] of incoming.entries()) {
  const where = `row ${i + 1}`;
  const name = normalizeName(m?.name);
  const phoneE164 = normalizePhone(m?.phoneE164 ?? m?.phone);
  const emailLower = normalizeEmail(m?.emailLower ?? m?.email);

  if (!name) {
    rejected.push(`${where}: unusable name ${JSON.stringify(m?.name)}`);
    continue;
  }
  if (!phoneE164 && !emailLower) {
    rejected.push(`${where}: ${name} has no valid phone or email`);
    continue;
  }

  const identity = phoneE164 ? { type: 'phone', value: phoneE164 } : { type: 'email', value: emailLower };
  const id = memberDocId(identity);
  if (byId.has(id)) {
    rejected.push(`${where}: ${name} collides with ${byId.get(id).name} on id ${id}`);
    continue;
  }
  // Both contact details are stored when the office has both, so those members
  // can check in with whichever one they remember at the door.
  byId.set(id, { id, name, phoneE164, emailLower });
}

if (rejected.length) {
  console.error(`✗ ${rejected.length} record(s) did not pass validation — nothing was changed:\n`);
  for (const r of rejected) console.error(`    ${r}`);
  console.error('\nFix the input and re-run.');
  process.exit(1);
}

const toWrite = [...byId.values()];
console.log(`✓ All ${toWrite.length} records valid.`);
console.log(`    with a phone: ${toWrite.filter((m) => m.phoneE164).length}`);
console.log(`    with an email: ${toWrite.filter((m) => m.emailLower).length}\n`);

// --------------------------------------------------------- inspect what goes
const existingMembers = await db.collection(COLLECTIONS.members).get();
const existingLimits = await db.collection(COLLECTIONS.rateLimits).get();

const keptIds = new Set(toWrite.map((m) => m.id));
const disappearing = existingMembers.docs.filter((d) => !keptIds.has(d.id));

console.log(`Currently on "${target}": ${existingMembers.size} members, ${existingLimits.size} rate-limit counters.`);
console.log(`  ${existingMembers.size - disappearing.length} keep their document id (history stays attached)`);
console.log(`  ${disappearing.length} are not in the file and will be removed:`);
for (const d of disappearing) {
  console.log(`      ${d.id}  ${JSON.stringify(d.get('name'))}  ${d.get('phoneE164') ?? d.get('emailLower') ?? ''}`);
}

// Some existing members predate deterministic ids and sit at a random one. If
// the file still has their number they are not leaving — they are moving to the
// id their number implies. Their attendance has to move with them, or a real
// check-in silently becomes a row pointing at nobody.
const remap = new Map();
for (const d of existingMembers.docs) {
  if (keptIds.has(d.id)) continue;
  const phoneE164 = d.get('phoneE164');
  const emailLower = d.get('emailLower');
  const identity = phoneE164
    ? { type: 'phone', value: phoneE164 }
    : emailLower
      ? { type: 'email', value: emailLower }
      : null;
  if (!identity) continue;
  const newId = memberDocId(identity);
  if (newId !== d.id && keptIds.has(newId)) remap.set(d.id, newId);
}

// Attendance is not deleted, but it points at member ids. Say plainly which
// rows move and which end up pointing at nobody.
const attendance = await db.collection(COLLECTIONS.attendance).get();
const moving = attendance.docs.filter((d) => remap.has(d.get('memberId')));
const orphaned = attendance.docs.filter(
  (d) => !keptIds.has(d.get('memberId')) && !remap.has(d.get('memberId')),
);

console.log(`\n${remap.size} member(s) move from a legacy random id to their phone-derived id:`);
for (const [oldId, newId] of remap) {
  const d = existingMembers.docs.find((x) => x.id === oldId);
  console.log(`      ${JSON.stringify(d.get('name'))}  ${oldId} -> ${newId}`);
}

console.log(`\nAttendance: ${attendance.size} records.`);
console.log(`  ${attendance.size - moving.length - orphaned.length} keep pointing at the same member`);
console.log(`  ${moving.length} re-pointed at the member's new id (history preserved):`);
for (const d of moving) {
  console.log(`      ${d.id}  ${JSON.stringify(d.get('name'))}  -> ${d.get('serviceDate')}_${remap.get(d.get('memberId'))}`);
}
console.log(`  ${orphaned.length} will reference a member the file has dropped:`);
for (const d of orphaned) {
  console.log(`      ${d.id}  ${JSON.stringify(d.get('name'))}`);
}

if (!commit) {
  console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.`);
  console.log(`Would delete ${existingMembers.size} members + ${existingLimits.size} rate-limit counters,`);
  console.log(`then write ${toWrite.length} members.`);
  console.log('First 10 that would be written:');
  for (const m of toWrite.slice(0, 10)) {
    console.log(`   ${m.id.padEnd(14)} ${m.name}  ${m.phoneE164 ?? ''} ${m.emailLower ?? ''}`);
  }
  process.exit(0);
}

// ------------------------------------------------------------------- apply
// Firestore caps a batch at 500 writes.
const inBatches = async (docs, label, apply) => {
  let done = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    const slice = docs.slice(i, i + 400);
    for (const d of slice) apply(batch, d);
    await batch.commit();
    done += slice.length;
    console.log(`  ${label} ${done}/${docs.length}`);
  }
};

console.log('\nDeleting members…');
await inBatches(existingMembers.docs, 'deleted', (batch, d) => batch.delete(d.ref));

console.log('Deleting rate-limit counters…');
await inBatches(existingLimits.docs, 'deleted', (batch, d) => batch.delete(d.ref));

console.log('Writing new roster…');
const createdAt = new Date();
await inBatches(toWrite, 'written', (batch, m) => {
  batch.set(db.doc(`${COLLECTIONS.members}/${m.id}`), {
    name: m.name,
    email: m.emailLower,
    emailLower: m.emailLower,
    phone: m.phoneE164,
    phoneE164: m.phoneE164,
    createdAt,
    source: 'import',
  });
});

// Re-point the attendance of everyone who moved id. Done last, so it can only
// ever land on a member document that now exists.
if (moving.length) {
  console.log('Re-pointing attendance…');
  let moved = 0;
  let clashed = 0;
  for (const d of moving) {
    const newId = remap.get(d.get('memberId'));
    const target = db.doc(`${COLLECTIONS.attendance}/${d.get('serviceDate')}_${newId}`);
    // The member may already have checked in under the new id on the same day.
    // That row is the same fact; keep it and just drop the duplicate.
    if ((await target.get()).exists) {
      clashed++;
    } else {
      await target.set({ ...d.data(), memberId: newId });
      moved++;
    }
    await d.ref.delete();
  }
  console.log(`  re-pointed ${moved}${clashed ? `, merged ${clashed} duplicate(s)` : ''}`);
}

const after = await db.collection(COLLECTIONS.members).get();
console.log(`\n✓ Done. "${target}" now holds ${after.size} members.`);
console.log('Run `npm run audit` to confirm the directory is consistent.');
process.exit(0);

/**
 * Read-only health check on the congregation data.
 *
 *   npm run audit                  # summary
 *   npm run audit -- --verbose     # every affected record
 *
 * Writes nothing, ever. Exits non-zero when it finds a problem, so it can be
 * run before a service or wired into CI.
 *
 * It checks the invariants the app now depends on. Two of these were violated
 * in production and are what caused people to be greeted by the wrong name:
 *
 *   - one phone number, one member document (a duplicate makes `.limit(1)` pick
 *     an arbitrary one, and it picks the same wrong one every time);
 *   - a member's document id is derived from their number, so the office, the
 *     import script and a self-registration at the door all converge on one row.
 *
 * The rest are the quieter ways a record stops being findable: a number that
 * doesn't survive normalisation, an invisible character in a name, an
 * attendance row pointing at someone who was deleted.
 */
import { db, target } from './_admin.mjs';
import { COLLECTIONS } from '../shared/collections.js';
import { memberDocId, normalizePhone, normalizeEmail, normalizeName } from '../shared/identity.js';

const verbose = process.argv.includes('--verbose');

const E164 = /^\+234[789]\d{9}$/;
const problems = [];
const note = (kind, detail) => problems.push({ kind, detail });

console.log(`\nAuditing "${target}" — read-only.\n`);

const members = await db.collection(COLLECTIONS.members).get();
const attendance = await db.collection(COLLECTIONS.attendance).get();
console.log(`  ${members.size} members, ${attendance.size} attendance records\n`);

// --------------------------------------------------------------- per-member
const byPhone = new Map();
const byEmail = new Map();

for (const d of members.docs) {
  const name = d.get('name');
  const phoneE164 = d.get('phoneE164') ?? null;
  const emailLower = d.get('emailLower') ?? null;
  const where = `${d.id} (${JSON.stringify(name)})`;

  if (!name || typeof name !== 'string' || !name.trim()) {
    note('no name', where);
  } else if (normalizeName(name) !== name.trim().replace(/\s+/g, ' ')) {
    // Four migrated names arrived carrying a leading U+200E, which makes them
    // impossible to find by typing them.
    note('name holds an invisible character', where);
  }

  if (!phoneE164 && !emailLower) {
    note('no contact detail — can never check in', where);
  }

  if (phoneE164) {
    if (!E164.test(phoneE164)) {
      note('phoneE164 is not a Nigerian E.164 number', `${where} -> ${JSON.stringify(phoneE164)}`);
    } else if (normalizePhone(phoneE164) !== phoneE164) {
      note('stored number does not survive normalisation', `${where} -> ${phoneE164}`);
    }
    const raw = d.get('phone');
    if (typeof raw === 'string' && raw && normalizePhone(raw) !== phoneE164) {
      note('phone and phoneE164 disagree', `${where} -> ${JSON.stringify(raw)} vs ${phoneE164}`);
    }
    if (!byPhone.has(phoneE164)) byPhone.set(phoneE164, []);
    byPhone.get(phoneE164).push(d);
  }

  if (emailLower) {
    if (normalizeEmail(emailLower) !== emailLower) {
      note('emailLower is not a normalised email', `${where} -> ${JSON.stringify(emailLower)}`);
    }
    if (!byEmail.has(emailLower)) byEmail.set(emailLower, []);
    byEmail.get(emailLower).push(d);
  }

  const identity = phoneE164
    ? { type: 'phone', value: phoneE164 }
    : emailLower
      ? { type: 'email', value: emailLower }
      : null;
  if (identity && d.id !== memberDocId(identity)) {
    // Not fatal — the lookup is by field, not id — but it means a second write
    // path could land the same person on a different document.
    note('document id is not derived from the contact detail', `${where} -> expected ${memberDocId(identity)}`);
  }
}

// -------------------------------------------------------------- duplicates
const norm = (s) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

for (const [phone, docs] of byPhone) {
  if (docs.length < 2) continue;
  const names = [...new Set(docs.map((d) => norm(d.get('name'))))];
  // Firestore appends an implicit sort by document id, so `.limit(1)` returns
  // the lowest — deterministically the same wrong person every time.
  const winner = [...docs].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  note(
    names.length > 1 ? 'one number, CONFLICTING names' : 'one number, duplicate records',
    `${phone} -> ${docs.map((d) => JSON.stringify(d.get('name'))).join(' | ')}` +
      (names.length > 1 ? `  [check-in answers "${winner.get('name')}"]` : ''),
  );
}

for (const [email, docs] of byEmail) {
  if (docs.length > 1) {
    note('one email, several records', `${email} -> ${docs.map((d) => d.id).join(', ')}`);
  }
}

// -------------------------------------------------------------- attendance
const memberIds = new Set(members.docs.map((d) => d.id));
const perDate = new Map();

for (const d of attendance.docs) {
  const memberId = d.get('memberId');
  const serviceDate = d.get('serviceDate');

  if (!memberIds.has(memberId)) {
    note('attendance points at a member who no longer exists', `${d.id} -> ${memberId}`);
    continue;
  }
  if (d.id !== `${serviceDate}_${memberId}`) {
    // The id is what makes a double-tap a no-op; a mismatch means it isn't.
    note('attendance id does not match its own fields', `${d.id} -> ${serviceDate}_${memberId}`);
  }
  const phone = members.docs.find((m) => m.id === memberId)?.get('phoneE164');
  if (phone) {
    const key = `${serviceDate}|${phone}`;
    perDate.set(key, (perDate.get(key) ?? 0) + 1);
  }
}

for (const [key, n] of perDate) {
  if (n > 1) note('one person counted twice on one service date', `${key} x${n}`);
}

// ------------------------------------------------------------------ report
const grouped = new Map();
for (const p of problems) {
  if (!grouped.has(p.kind)) grouped.set(p.kind, []);
  grouped.get(p.kind).push(p.detail);
}

if (!problems.length) {
  console.log('✓ No inconsistencies found.\n');
  process.exit(0);
}

console.log(`Found ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
for (const [kind, details] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(details.length).padStart(4)}  ${kind}`);
  for (const detail of verbose ? details : details.slice(0, 3)) {
    console.log(`        ${detail}`);
  }
  if (!verbose && details.length > 3) {
    console.log(`        …and ${details.length - 3} more (re-run with --verbose)`);
  }
}

console.log('\nNothing was changed — this command only reads.\n');
process.exit(1);

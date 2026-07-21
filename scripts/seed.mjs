/**
 * Writes the default access config, and with --demo a congregation plus a
 * month of Sunday attendance to look at.
 *
 *   npm run seed            # config only
 *   npm run seed -- --demo  # ...plus sample data
 *
 * Credentials come from FIREBASE_SERVICE_ACCOUNT in `.env` (base64 of the
 * service-account key), or from the shell, which wins if both are set.
 *
 * --demo writes real documents to a real database. Every demo id is prefixed
 * `demo-` so they're easy to find and delete again.
 *
 * Safe to re-run: the config is merged, and every demo document has a
 * deterministic id so nothing duplicates.
 */
import { db, confirmLive, target } from './_admin.mjs';
import { DEFAULT_CONFIG, addDays } from '../shared/access.js';
import { COLLECTIONS, ACCESS_CONFIG_DOC } from '../shared/collections.js';
import { normalizeEmail, normalizePhone } from '../shared/identity.js';

const demo = process.argv.includes('--demo');

confirmLive()

await db.doc(ACCESS_CONFIG_DOC).set(DEFAULT_CONFIG, { merge: true });
console.log(`✓ ${ACCESS_CONFIG_DOC} seeded on ${target} (open on Sunday, Africa/Lagos)`);

if (!demo) {
  console.log('\nPass --demo to add sample members and attendance.');
  process.exit(0);
}

// --------------------------------------------------------------- sample data

/** The last `count` Sundays, oldest first, ending with the most recent one. */
function recentSundays(count) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const lastSunday = addDays(today, -new Date(`${today}T12:00:00Z`).getUTCDay());

  return Array.from({ length: count }, (_, i) => addDays(lastSunday, -7 * (count - 1 - i)));
}

const sundays = recentSundays(4);
const [wk1, wk2, wk3, wk4] = sundays;

// Attendance is varied on purpose, so the report has something to say rather
// than a wall of identical rows.
const people = [
  { name: 'Ada Obi',      email: 'ada@example.com',    phone: '08031234567',      came: sundays },
  { name: 'Tunde Bello',  email: 'tunde@example.com',  phone: '+234 703 123 4567', came: [wk1, wk3, wk4] },
  { name: 'Chisom Eze',   email: 'chisom@example.com', phone: '2349031234567',    came: [wk1] },
  { name: 'Grace Ade',    email: 'grace@example.com',  phone: '07051234567',      came: [wk4] },
  { name: 'Emeka Nwosu',  email: null,                 phone: '08121234567',      came: [] },
  { name: 'Blessing Udo', email: 'blessing@example.com', phone: '09012345678',    came: [wk2, wk3, wk4] },
  { name: 'Segun Alabi',  email: 'segun@example.com',  phone: '0802 987 6543',    came: [wk1, wk2] },
  { name: 'Ngozi Okafor', email: 'ngozi@example.com',  phone: '08145556677',      came: sundays },
];
try {
const batch = db.batch();
let visits = 0;

for (const person of people) {
  const emailLower = person.email ? normalizeEmail(person.email) : null;
  const phoneE164 = person.phone ? normalizePhone(person.phone) : null;

  // Catch a typo in this file rather than writing a member nobody can find.
  if (person.phone && !phoneE164) throw new Error(`bad demo phone: ${person.phone}`);
  if (person.email && !emailLower) throw new Error(`bad demo email: ${person.email}`);

  const id = `demo-${(emailLower ?? phoneE164).replace(/[^a-z0-9]/gi, '')}`;

  batch.set(
    db.doc(`${COLLECTIONS.members}/${id}`),
    {
      name: person.name,
      email: emailLower,
      emailLower,
      phone: person.phone,
      phoneE164,
      createdAt: new Date(),
    },
    { merge: true },
  );

  for (const date of person.came) {
    batch.set(
      db.doc(`${COLLECTIONS.attendance}/${date}_${id}`),
      {
        memberId: id,
        name: person.name,
        serviceDate: date,
        // Staggered so the Day view's times aren't all identical.
        checkedInAt: new Date(`${date}T08:${String(30 + (visits % 25)).padStart(2, '0')}:00Z`),
        via: 'phone',
      },
      { merge: true },
    );
    visits++;
  }
}

await batch.commit();

const absent = people.filter((p) => !p.came.length).length;
console.log(`✓ ${people.length} members, ${visits} check-ins across ${sundays.length} Sundays`);
console.log(`  (${sundays[0]} → ${sundays.at(-1)})`);
console.log(`  ${absent} never came — they're the "Not in church" list for the month.`);

console.log('\nNext: create an admin so you can sign in —');
console.log(`  npm run create-admin -- you@church.ng`);
process.exit(0);
} catch(e) {
  console.log("An error occurred while seeding profiles")
  console.error(e)
}
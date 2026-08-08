import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTIONS,
  call,
  checkIn,
  count,
  db,
  docsOf,
  memberDocId,
  register,
  reset,
  seedMember,
  setWindow,
  today,
} from './_setup.mjs';

beforeEach(async () => {
  await reset();
  await setWindow(true);
});

const phonesOf = (docs) => docs.map((d) => d.get('phoneE164'));

test('a newcomer registers and is checked in by the same request', async () => {
  const { status, body } = await call(register, {
    identifier: '08123456789',
    name: 'Chidi Nwankwo',
  });

  assert.equal(status, 200);
  assert.equal(body.created, true);
  assert.equal(body.found, true);
  assert.equal(body.name, 'Chidi Nwankwo');
  assert.equal(body.alreadyCheckedIn, false);

  const members = await docsOf(COLLECTIONS.members);
  assert.equal(members.length, 1);
  assert.equal(members[0].id, '2348123456789', 'id must be the phone digits');
  assert.equal(members[0].get('source'), 'self');
  assert.equal(members[0].get('phoneE164'), '+2348123456789');

  const records = await docsOf(COLLECTIONS.attendance);
  assert.equal(records.length, 1);
  assert.equal(records[0].get('via'), 'self');
});

test('registering the same number twice never makes a second person', async () => {
  await call(register, { identifier: '08123456789', name: 'Chidi Nwankwo' });
  const second = await call(register, { identifier: '08123456789', name: 'Someone Else' });

  assert.equal(second.body.created, false);
  assert.equal(second.body.name, 'Chidi Nwankwo', 'an existing name must never be overwritten');
  assert.equal(await count(COLLECTIONS.members), 1);
});

test('registering over an existing member degrades to a check-in', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });

  const { status, body } = await call(register, { identifier: '08031234567', name: 'Impostor' });

  assert.equal(status, 200);
  assert.equal(body.created, false);
  assert.equal(body.name, 'Ada Obi');
  assert.equal(await count(COLLECTIONS.members), 1);
  assert.equal(await count(COLLECTIONS.attendance), 1, 'they are still counted as present');
});

test('a member on a legacy random id is found, not duplicated', async () => {
  // The 11 members added through the UI before ids became deterministic.
  await db.collection(COLLECTIONS.members).doc('LegacyRandomId123456').set({
    name: 'Tunde Mciver',
    email: null,
    emailLower: null,
    phone: '08053531131',
    phoneE164: '+2348053531131',
    createdAt: new Date(),
  });

  const { body } = await call(register, { identifier: '08053531131', name: 'Someone Else' });

  assert.equal(body.created, false);
  assert.equal(body.name, 'Tunde Mciver');
  assert.equal(await count(COLLECTIONS.members), 1, 'the query must catch the legacy id');
});

test('ten simultaneous registrations of one number create exactly one member', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call(register, { identifier: '08123456789', name: `Racer ${i}` }),
    ),
  );

  const members = await docsOf(COLLECTIONS.members);
  assert.equal(members.length, 1, 'the transaction is what makes this safe');
  assert.equal(await count(COLLECTIONS.attendance), 1);
  assert.equal(results.filter((r) => r.body.created).length, 1, 'exactly one caller created it');
});

test('a crowd registering different numbers at once all get through', async () => {
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      call(
        register,
        { identifier: `081234567${String(i).padStart(2, '0')}`, name: `Newcomer ${i}` },
        // Distinct IPs: one shared address is covered by the rate-limit suite.
        { ip: `10.0.1.${i}` },
      ),
    ),
  );

  assert.ok(
    results.every((r) => r.status === 200 && r.body.created),
    'no newcomer should be turned away',
  );
  const members = await docsOf(COLLECTIONS.members);
  assert.equal(members.length, 25);
  assert.equal(new Set(phonesOf(members)).size, 25, 'no number may appear twice');
});

test('a name that is not a name is refused', async () => {
  for (const name of ['', ' ', 'a', '12345', '...', null, 42, 'a'.repeat(81)]) {
    const { status, body } = await call(register, { identifier: '08055554444', name });
    assert.equal(status, 400, `should reject ${JSON.stringify(name)}`);
    assert.equal(body.error, 'invalid_name');
  }
  assert.equal(await count(COLLECTIONS.members), 0);
});

test('an invalid number is refused before anything is written', async () => {
  const { status, body } = await call(register, { identifier: '0601234567', name: 'Bad Number' });

  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_identifier');
  assert.equal(await count(COLLECTIONS.members), 0);
});

test('bidi marks and stray whitespace are cleaned before storage', async () => {
  const { body } = await call(register, {
    identifier: '08099998888',
    name: '‎Ngozi   Okafor ',
  });

  assert.equal(body.name, 'Ngozi Okafor');
  const doc = await db.doc(`${COLLECTIONS.members}/2348099998888`).get();
  assert.equal(doc.get('name'), 'Ngozi Okafor');
});

test('registration is refused while the window is closed', async () => {
  await setWindow(false);

  const { status, body } = await call(register, { identifier: '08123456789', name: 'Chidi' });

  assert.equal(status, 403);
  assert.equal(body.error, 'closed');
  assert.equal(await count(COLLECTIONS.members), 0);
});

test('an email-only registration lands on a prefixed id', async () => {
  const { body } = await call(register, { identifier: 'Ada@Example.COM', name: 'Ada Obi' });

  assert.equal(body.created, true);
  const members = await docsOf(COLLECTIONS.members);
  assert.equal(members[0].id, memberDocId({ type: 'email', value: 'ada@example.com' }));
  assert.equal(members[0].get('emailLower'), 'ada@example.com');
  assert.equal(members[0].get('phoneE164'), null);
});

test('a self-registered member can then check in normally', async () => {
  await call(register, { identifier: '08123456789', name: 'Chidi Nwankwo' });

  const { body } = await call(checkIn, { identifier: '+234 812 345 6789' });

  assert.equal(body.found, true);
  assert.equal(body.name, 'Chidi Nwankwo');
  assert.equal(body.alreadyCheckedIn, true, 'registration already counted them today');
  assert.equal(await count(COLLECTIONS.attendance), 1);
  assert.equal((await docsOf(COLLECTIONS.attendance))[0].id, `${today()}_2348123456789`);
});

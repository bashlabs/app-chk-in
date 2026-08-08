import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTIONS,
  call,
  checkIn,
  count,
  db,
  docsOf,
  dispute,
  reset,
  seedMember,
  setWindow,
  today,
} from './_setup.mjs';

beforeEach(async () => {
  await reset();
  await setWindow(true);
});

test('the Elijah case: a correction is captured without touching the member', async () => {
  // Exactly the live data — his number, carrying someone else's name.
  const id = await seedMember({ name: 'Elena', phone: '+2347032320577' });

  const greeting = await call(checkIn, { identifier: '07032320577' });
  assert.equal(greeting.body.name, 'Elena', 'reproduces what he saw');

  const { status, body } = await call(dispute, {
    identifier: '07032320577',
    claimedName: 'Elijah Adewale',
  });

  assert.equal(status, 200);
  assert.equal(body.recorded, true);

  const reports = await docsOf(COLLECTIONS.disputes);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].get('shownName'), 'Elena');
  assert.equal(reports[0].get('claimedName'), 'Elijah Adewale');
  assert.equal(reports[0].get('shownMemberId'), id);
  assert.equal(reports[0].get('resolved'), false);

  // The whole point: nothing was renamed on his say-so.
  const member = await db.doc(`${COLLECTIONS.members}/${id}`).get();
  assert.equal(member.get('name'), 'Elena', 'a dispute must never rewrite the directory');
});

test('reporting twice updates one report rather than queueing duplicates', async () => {
  await seedMember({ name: 'Elena', phone: '+2347032320577' });

  await call(dispute, { identifier: '07032320577', claimedName: 'Elijah Adewale' });
  await call(dispute, { identifier: '07032320577', claimedName: 'Elijah A. Adewale' });

  const reports = await docsOf(COLLECTIONS.disputes);
  assert.equal(reports.length, 1, 'one per number per service date');
  assert.equal(reports[0].get('claimedName'), 'Elijah A. Adewale', 'the latest wins');
});

test('the report is filed against the service date', async () => {
  await seedMember({ name: 'Elena', phone: '+2347032320577' });
  await call(dispute, { identifier: '07032320577', claimedName: 'Elijah Adewale' });

  const reports = await docsOf(COLLECTIONS.disputes);
  assert.equal(reports[0].id, `${today()}_2347032320577`);
  assert.equal(reports[0].get('serviceDate'), today());
});

test('the shown name is resolved server-side, not taken from the client', async () => {
  await seedMember({ name: 'Elena', phone: '+2347032320577' });

  // A client claiming someone else was shown must be ignored.
  await call(dispute, {
    identifier: '07032320577',
    claimedName: 'Elijah Adewale',
    shownName: 'Someone Fabricated',
  });

  const reports = await docsOf(COLLECTIONS.disputes);
  assert.equal(reports[0].get('shownName'), 'Elena');
});

test('a junk claimed name is refused', async () => {
  await seedMember({ name: 'Elena', phone: '+2347032320577' });

  for (const claimedName of ['', 'a', '12345', null]) {
    const { status } = await call(dispute, { identifier: '07032320577', claimedName });
    assert.equal(status, 400, `should reject ${JSON.stringify(claimedName)}`);
  }
  assert.equal(await count(COLLECTIONS.disputes), 0);
});

test('an invalid number is refused', async () => {
  const { status, body } = await call(dispute, {
    identifier: '0601234567',
    claimedName: 'Elijah Adewale',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_identifier');
  assert.equal(await count(COLLECTIONS.disputes), 0);
});

test('a report about a number not on file is still captured', async () => {
  const { status } = await call(dispute, {
    identifier: '08099998888',
    claimedName: 'Unknown Person',
  });

  assert.equal(status, 200);
  const reports = await docsOf(COLLECTIONS.disputes);
  assert.equal(reports[0].get('shownName'), null);
  assert.equal(reports[0].get('shownMemberId'), null);
});

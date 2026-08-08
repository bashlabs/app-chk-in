import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTIONS,
  call,
  checkIn,
  count,
  db,
  docsOf,
  reset,
  seedMember,
  setWindow,
  today,
} from './_setup.mjs';

beforeEach(async () => {
  await reset();
  await setWindow(true);
});

test('a member on file is found and their attendance recorded', async () => {
  const id = await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });

  const { status, body } = await call(checkIn, { identifier: '08031234567' });

  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.equal(body.name, 'Ada Obi');
  assert.equal(body.alreadyCheckedIn, false);

  const records = await docsOf(COLLECTIONS.attendance);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, `${today()}_${id}`);
  assert.equal(records[0].get('memberId'), id);
  assert.equal(records[0].get('via'), 'phone');
});

test('every format of one number reaches the same person', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });

  for (const format of ['08031234567', '+234 803 123 4567', '2348031234567', '0803-123-4567']) {
    const { body } = await call(checkIn, { identifier: format });
    assert.equal(body.found, true, `failed for ${format}`);
    assert.equal(body.name, 'Ada Obi');
  }
  // Still one row: same person, same day, however they typed it.
  assert.equal(await count(COLLECTIONS.attendance), 1);
});

test('a second check-in the same day is a no-op, not a second row', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });

  const first = await call(checkIn, { identifier: '08031234567' });
  const second = await call(checkIn, { identifier: '08031234567' });

  assert.equal(first.body.alreadyCheckedIn, false);
  assert.equal(second.body.alreadyCheckedIn, true);
  assert.equal(await count(COLLECTIONS.attendance), 1);
});

test('twenty people checking in at once each get exactly one row', async () => {
  const ids = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      seedMember({ name: `Member ${i}`, phone: `+23480312345${String(i).padStart(2, '0')}` }),
    ),
  );

  const results = await Promise.all(
    ids.map((_, i) => call(checkIn, { identifier: `080312345${String(i).padStart(2, '0')}` })),
  );

  assert.ok(results.every((r) => r.body.found === true));
  assert.equal(await count(COLLECTIONS.attendance), 20);
});

test('the same person tapping twice at the same instant still yields one row', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => call(checkIn, { identifier: '08031234567' })),
  );

  assert.ok(results.every((r) => r.body.found === true));
  assert.equal(await count(COLLECTIONS.attendance), 1, 'the transaction must dedupe the race');
});

test('an unknown number is a miss, and writes nothing', async () => {
  const { status, body } = await call(checkIn, { identifier: '08099998888' });

  assert.equal(status, 200);
  assert.equal(body.found, false);
  assert.equal(body.name, undefined, 'a miss must not echo anything back');
  assert.equal(await count(COLLECTIONS.attendance), 0);
});

test('a malformed number is rejected before any lookup', async () => {
  const { status, body } = await call(checkIn, { identifier: '0601234567' });

  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_identifier');
});

test('the response never leaks a stored contact detail', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567', email: 'ada@example.com' });

  const { body } = await call(checkIn, { identifier: '08031234567' });
  const serialised = JSON.stringify(body);

  assert.ok(!serialised.includes('2348031234567'), 'phone must not come back');
  assert.ok(!serialised.includes('ada@example.com'), 'email must not come back');
});

test('a closed window turns everyone away without recording anything', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });
  await setWindow(false);

  const { status, body } = await call(checkIn, { identifier: '08031234567' });

  assert.equal(status, 403);
  assert.equal(body.error, 'closed');
  assert.equal(await count(COLLECTIONS.attendance), 0);
});

test('a duplicate member cannot be created by check-in itself', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });
  await call(checkIn, { identifier: '08031234567' });
  await call(checkIn, { identifier: '08031234567' });

  assert.equal(await count(COLLECTIONS.members), 1);
});

test('the name written to attendance is the one on the member record', async () => {
  const id = await seedMember({ name: 'Elena', phone: '+2347032320577' });
  await call(checkIn, { identifier: '07032320577' });

  const record = await db.doc(`${COLLECTIONS.attendance}/${today()}_${id}`).get();
  assert.equal(record.get('name'), 'Elena');
});

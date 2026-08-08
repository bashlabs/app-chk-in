/**
 * The Sunday-morning properties: a crowd must never throttle itself, and a
 * scraper must run out of road quickly.
 *
 * `_setup.mjs` tightens the limits so these finish fast — 5 failed lookups and
 * 3 public writes per window, against the shipped defaults of 50 and 25.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTIONS,
  call,
  checkIn,
  count,
  dispute,
  register,
  reset,
  seedMember,
  setWindow,
} from './_setup.mjs';

const CHURCH_WIFI = '196.0.0.1';

beforeEach(async () => {
  await reset();
  await setWindow(true);
});

test('a whole congregation on one wifi IP never throttles itself', async () => {
  // 60 real members, one shared address — the exact shape of a busy Sunday, and
  // far past the 5-failure ceiling. Successes must not count towards it.
  const phones = Array.from({ length: 60 }, (_, i) => `+23480300000${String(i).padStart(2, '0')}`);
  await Promise.all(phones.map((phone, i) => seedMember({ name: `Member ${i}`, phone })));

  const results = [];
  for (const phone of phones) {
    results.push(await call(checkIn, { identifier: phone }, { ip: CHURCH_WIFI }));
  }

  assert.equal(
    results.filter((r) => r.status === 429).length,
    0,
    'not one member may be told "too many attempts"',
  );
  assert.ok(results.every((r) => r.body.found === true));
  assert.equal(await count(COLLECTIONS.attendance), 60);
  assert.equal(await count(COLLECTIONS.rateLimits), 0, 'a success writes no counter at all');
});

test('a scraper walking the number space is cut off', async () => {
  const attacker = '203.0.113.7';
  const outcomes = [];

  for (let i = 0; i < 12; i++) {
    outcomes.push(
      await call(checkIn, { identifier: `0803999${String(i).padStart(4, '0')}` }, { ip: attacker }),
    );
  }

  const blocked = outcomes.filter((r) => r.status === 429);
  assert.ok(blocked.length > 0, 'the limiter has to bite');
  // 5 misses are allowed, the 6th onwards is refused.
  assert.equal(outcomes.slice(0, 5).every((r) => r.status === 200), true);
  assert.equal(outcomes.at(-1).status, 429);
});

test('one IP being blocked does not affect anyone else', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });

  for (let i = 0; i < 8; i++) {
    await call(checkIn, { identifier: `0803999${String(i).padStart(4, '0')}` }, { ip: '203.0.113.7' });
  }
  const blocked = await call(checkIn, { identifier: '08031234567' }, { ip: '203.0.113.7' });
  const other = await call(checkIn, { identifier: '08031234567' }, { ip: '196.0.0.9' });

  assert.equal(blocked.status, 429);
  assert.equal(other.status, 200, 'the limiter is per address, not global');
  assert.equal(other.body.found, true);
});

test('garbage input counts against the limiter too', async () => {
  const prober = '203.0.113.8';
  for (let i = 0; i < 6; i++) {
    await call(checkIn, { identifier: `not-a-number-${i}` }, { ip: prober });
  }

  const { status } = await call(checkIn, { identifier: 'still-not-a-number' }, { ip: prober });
  assert.equal(status, 429);
});

test('registrations are metered on their own budget, not the lookup one', async () => {
  const ip = '196.0.0.20';

  // Spend the whole failed-lookup budget first.
  for (let i = 0; i < 6; i++) {
    await call(checkIn, { identifier: `0803999${String(i).padStart(4, '0')}` }, { ip });
  }
  assert.equal((await call(checkIn, { identifier: '08039990000' }, { ip })).status, 429);

  // Registration has its own ceiling and is untouched by the above.
  const { status, body } = await call(
    register,
    { identifier: '08123456789', name: 'Chidi Nwankwo' },
    { ip },
  );
  assert.equal(status, 200);
  assert.equal(body.created, true);
});

test('the public-write budget stops someone minting members in bulk', async () => {
  const ip = '203.0.113.9';
  const outcomes = [];

  for (let i = 0; i < 6; i++) {
    outcomes.push(
      await call(
        register,
        { identifier: `081200000${String(i).padStart(2, '0')}`, name: `Fake ${i}` },
        { ip },
      ),
    );
  }

  const blocked = outcomes.filter((r) => r.status === 429);
  assert.ok(blocked.length > 0, 'unbounded member creation is the risk this closes');
  assert.ok(
    (await count(COLLECTIONS.members)) <= 4,
    'no more than the budget plus the in-flight one may be created',
  );
});

test('re-registering the same number does not burn the write budget', async () => {
  const ip = '196.0.0.21';

  // The id is derived from the number, so a repeat submit creates nothing —
  // and must not be charged as though it had.
  for (let i = 0; i < 6; i++) {
    const { status } = await call(register, { identifier: '08123456789', name: 'Chidi' }, { ip });
    assert.equal(status, 200, 'a returning person must never be refused');
  }
  assert.equal(await count(COLLECTIONS.members), 1);
});

test('disputes share the public-write budget', async () => {
  const ip = '203.0.113.10';
  await seedMember({ name: 'Elena', phone: '+2347032320577' });

  const outcomes = [];
  for (let i = 0; i < 6; i++) {
    outcomes.push(
      await call(dispute, { identifier: '07032320577', claimedName: `Name ${i}` }, { ip }),
    );
  }

  assert.ok(outcomes.some((r) => r.status === 429));
});

test('a request with no client IP is still served', async () => {
  await seedMember({ name: 'Ada Obi', phone: '+2348031234567' });

  const { status, body } = await call(checkIn, { identifier: '08031234567' }, { ip: null });

  assert.equal(status, 200, 'a missing address must fail open, not lock the door');
  assert.equal(body.found, true);
});

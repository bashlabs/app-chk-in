import test from 'node:test';
import assert from 'node:assert/strict';

// Node strips the types itself (see the --experimental-strip-types flag on the
// test script), so this runs without a build step.
import {
  addDays,
  startOfWeek,
  endOfMonth,
  rangeFor,
  shift,
  labelFor,
} from '../src/lib/period.ts';

test('week runs Sunday to Saturday', () => {
  // 2026-07-19 is a Sunday; 2026-07-16 is the Thursday before.
  assert.equal(startOfWeek('2026-07-19'), '2026-07-19');
  assert.equal(startOfWeek('2026-07-16'), '2026-07-12');
  assert.deepEqual(rangeFor('week', '2026-07-16'), { start: '2026-07-12', end: '2026-07-18' });
});

test('month range covers the whole month', () => {
  assert.deepEqual(rangeFor('month', '2026-07-16'), { start: '2026-07-01', end: '2026-07-31' });
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfMonth('2028-02-10'), '2028-02-29'); // leap year
  assert.equal(endOfMonth('2026-12-01'), '2026-12-31');
});

test('day range is a single day', () => {
  assert.deepEqual(rangeFor('day', '2026-07-19'), { start: '2026-07-19', end: '2026-07-19' });
});

test('shifting a month never overflows', () => {
  // The classic bug: 31 Jan + 1 month = 3 March. Anchoring on the 1st avoids it.
  assert.equal(shift('month', '2026-01-31', 1), '2026-02-01');
  assert.equal(shift('month', '2026-03-15', -1), '2026-02-01');
  assert.equal(shift('month', '2026-12-15', 1), '2027-01-01');
  assert.equal(shift('month', '2026-01-15', -1), '2025-12-01');
});

test('shifting days and weeks crosses year boundaries', () => {
  assert.equal(shift('day', '2026-12-31', 1), '2027-01-01');
  assert.equal(shift('week', '2026-07-19', 1), '2026-07-26');
  assert.equal(shift('week', '2026-01-04', -1), '2025-12-28');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

// Intl separates range parts with thin/narrow no-break spaces, which are
// invisible but not U+0020. Compare on normalised whitespace.
const label = (...args) => labelFor(...args).replace(/\s+/g, ' ');

test('labels only repeat what changes', () => {
  // Locale pinned here only so the assertions are stable; the app passes none
  // and follows the admin's own locale.
  assert.equal(label('month', '2026-07-16', 'en-GB'), 'July 2026');
  assert.equal(label('day', '2026-07-19', 'en-GB'), 'Sunday, 19 July 2026');

  // Week inside one month: the month appears once.
  assert.equal(label('week', '2026-07-16', 'en-GB'), '12–18 Jul 2026');
  // Week straddling two months: both months appear.
  assert.equal(label('week', '2026-07-01', 'en-GB'), '28 Jun – 4 Jul 2026');
  // Week straddling two years: both years appear.
  assert.equal(label('week', '2026-01-01', 'en-GB'), '28 Dec 2025 – 3 Jan 2026');
});

test('week labels follow the reader’s locale', () => {
  // Same week, US conventions: month first, year once at the end.
  assert.equal(label('week', '2026-07-16', 'en-US'), 'Jul 12 – 18, 2026');
});

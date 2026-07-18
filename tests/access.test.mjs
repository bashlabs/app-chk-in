import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAccess, resolveConfig, zonedNow } from '../shared/access.js';

const base = resolveConfig({});

// 2026-07-19 is a Sunday. Lagos is UTC+1 year-round (no DST).
const SUN_10AM = new Date('2026-07-19T09:00:00Z');
const WED_10AM = new Date('2026-07-15T09:00:00Z');

test('the default schedule opens on Sunday only', () => {
  assert.equal(evaluateAccess(base, SUN_10AM).open, true);
  assert.equal(evaluateAccess(base, WED_10AM).open, false);
  assert.equal(evaluateAccess(base, WED_10AM).reason, 'day');
});

test('points a closed page at the next Sunday', () => {
  assert.equal(evaluateAccess(base, WED_10AM).nextOpenDate, '2026-07-19');
});

test('the service date follows Lagos, not UTC', () => {
  // 23:30 UTC Saturday is already 00:30 Sunday in Lagos.
  const satNight = new Date('2026-07-18T23:30:00Z');
  assert.equal(evaluateAccess(base, satNight).serviceDate, '2026-07-19');
  assert.equal(evaluateAccess(base, satNight).open, true);

  // 23:30 UTC Sunday is already Monday in Lagos.
  assert.equal(evaluateAccess(base, new Date('2026-07-19T23:30:00Z')).open, false);
});

test('midnight reads as minute 0, not 1440', () => {
  assert.equal(zonedNow(new Date('2026-07-18T23:00:00Z'), 'Africa/Lagos').minutes, 0);
});

test('honours a service time window', () => {
  const cfg = resolveConfig({ startMinutes: 7 * 60, endMinutes: 14 * 60 });
  assert.equal(evaluateAccess(cfg, SUN_10AM).open, true);
  assert.equal(evaluateAccess(cfg, new Date('2026-07-19T05:00:00Z')).open, false);
  assert.equal(evaluateAccess(cfg, new Date('2026-07-19T05:00:00Z')).reason, 'time');
  assert.equal(evaluateAccess(cfg, new Date('2026-07-19T15:00:00Z')).open, false);

  // Before the window it opens later today; after it, not until next Sunday.
  assert.equal(evaluateAccess(cfg, new Date('2026-07-19T05:00:00Z')).nextOpenDate, '2026-07-19');
  assert.equal(evaluateAccess(cfg, new Date('2026-07-19T15:00:00Z')).nextOpenDate, '2026-07-26');
});

test('manual overrides beat the schedule', () => {
  assert.equal(evaluateAccess(resolveConfig({ mode: 'open' }), WED_10AM).open, true);
  assert.equal(evaluateAccess(resolveConfig({ mode: 'closed' }), SUN_10AM).open, false);
  assert.equal(evaluateAccess(resolveConfig({ mode: 'closed' }), SUN_10AM).reason, 'disabled');
});

test('an expiring override falls back to the schedule', () => {
  const cfg = resolveConfig({ mode: 'open', overrideUntil: '2026-07-15T10:00:00Z' });
  assert.equal(evaluateAccess(cfg, new Date('2026-07-15T09:00:00Z')).open, true);
  assert.equal(evaluateAccess(cfg, new Date('2026-07-15T11:00:00Z')).open, false);
});

test('accepts a Firestore Timestamp for overrideUntil', () => {
  const cfg = resolveConfig({
    mode: 'open',
    overrideUntil: { toMillis: () => Date.parse('2026-07-15T10:00:00Z') },
  });
  assert.equal(evaluateAccess(cfg, new Date('2026-07-15T09:00:00Z')).open, true);
  assert.equal(evaluateAccess(cfg, new Date('2026-07-15T11:00:00Z')).open, false);
});

test('supports midweek services', () => {
  const cfg = resolveConfig({ allowedDays: [0, 3] });
  assert.equal(evaluateAccess(cfg, WED_10AM).open, true);
  assert.equal(evaluateAccess(cfg, new Date('2026-07-16T09:00:00Z')).nextOpenDate, '2026-07-19');
});

test('a bad admin write cannot wedge the page open or shut', () => {
  assert.deepEqual(resolveConfig({ allowedDays: 'sunday' }).allowedDays, [0]);
  assert.deepEqual(resolveConfig({ allowedDays: [0, 9] }).allowedDays, [0]);
  assert.equal(resolveConfig({ mode: 'nonsense' }).mode, 'schedule');
  assert.equal(resolveConfig({ timezone: 'Mars/Olympus' }).timezone, 'Africa/Lagos');

  const inverted = resolveConfig({ startMinutes: 900, endMinutes: 60 });
  assert.equal(inverted.startMinutes, null);
  assert.equal(inverted.endMinutes, null);
});

test('no enabled days means never open', () => {
  const cfg = resolveConfig({ allowedDays: [] });
  assert.equal(evaluateAccess(cfg, SUN_10AM).open, false);
  assert.equal(evaluateAccess(cfg, WED_10AM).nextOpenDate, null);
});

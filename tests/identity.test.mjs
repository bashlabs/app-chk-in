import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPhone,
  memberDocId,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
} from '../shared/identity.js';

test('accepts every Nigerian format for the same number', () => {
  const expected = '+2347031234567';
  const inputs = [
    '+2347031234567',
    '2347031234567',
    '07031234567',
    '7031234567',
    '+234 703 123 4567',
    '0703-123-4567',
    '(0703) 123 4567',
    '002347031234567',
    '  07031234567  ',
    '+234070 3123 4567', // mixed +234 and trunk 0
  ];
  for (const input of inputs) {
    assert.equal(normalizePhone(input), expected, `failed for ${input}`);
  }
});

test('accepts 7, 8 and 9 series mobiles', () => {
  assert.equal(normalizePhone('08031234567'), '+2348031234567');
  assert.equal(normalizePhone('09031234567'), '+2349031234567');
  assert.equal(normalizePhone('07031234567'), '+2347031234567');
});

test('rejects malformed or non-Nigerian numbers', () => {
  for (const input of ['070312345', '0603123456', '0123456789', '+1 415 555 1234', '', 'hello', '0']) {
    assert.equal(normalizePhone(input), null, `should reject ${input}`);
  }
});

test('routes on the @ sign and lowercases emails', () => {
  assert.deepEqual(normalizeIdentifier('  Pastor@Church.NG '), { type: 'email', value: 'pastor@church.ng' });
  assert.deepEqual(normalizeIdentifier('08031234567'), { type: 'phone', value: '+2348031234567' });
});

test('rejects malformed emails', () => {
  for (const input of ['@x.com', 'a@b', 'a b@c.com', 'a@.com']) {
    assert.equal(normalizeIdentifier(input), null, `should reject ${input}`);
  }
});

test('ignores non-string input', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.equal(normalizeIdentifier(input), null);
  }
});

test('formats for display', () => {
  assert.equal(formatPhone('+2348031234567'), '+234 803 123 4567');
  assert.equal(formatPhone('not-a-number'), 'not-a-number');
});

// --------------------------------------------------- deterministic member ids

test('a member id is the phone digits, matching the migration script', () => {
  assert.equal(memberDocId({ type: 'phone', value: '+2348031234567' }), '2348031234567');
});

test('every format of one number lands on the same document id', () => {
  const ids = ['08031234567', '+234 803 123 4567', '2348031234567', '8031234567'].map((raw) =>
    memberDocId(normalizeIdentifier(raw)),
  );
  assert.equal(new Set(ids).size, 1, 'one person must only ever occupy one document');
});

test('email ids are prefixed so an all-digit local part cannot collide with a phone', () => {
  assert.equal(memberDocId({ type: 'email', value: 'ada@example.com' }), 'e-ada@example.com');
  assert.notEqual(
    memberDocId({ type: 'email', value: '2348031234567@example.com' }),
    memberDocId({ type: 'phone', value: '+2348031234567' }),
  );
});

// -------------------------------------------------------------- name cleaning

test('strips the bidi marks that came through the spreadsheet import', () => {
  assert.equal(normalizeName('\u200eEziukwu dikachi Stanley'), 'Eziukwu dikachi Stanley');
  assert.equal(normalizeName('Lanre\u202a Kola-David'), 'Lanre Kola-David');
});

test('collapses whitespace and trims', () => {
  assert.equal(normalizeName('  Ada   Obi \n'), 'Ada Obi');
});

test('rejects input that is not a name', () => {
  for (const input of ['', ' ', 'a', '...', '12345', '\u200e', null, undefined, 42]) {
    assert.equal(normalizeName(input), null, `should reject ${JSON.stringify(input)}`);
  }
});

test('caps the length, so a name cannot become a payload', () => {
  assert.equal(normalizeName('a'.repeat(81)), null);
  assert.equal(normalizeName('a'.repeat(80)), 'a'.repeat(80));
});

test('keeps accented and non-Latin names intact', () => {
  assert.equal(normalizeName('Olúwáṣeun Adéyẹmí'), 'Olúwáṣeun Adéyẹmí');
});

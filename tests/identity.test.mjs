import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeIdentifier, normalizePhone, formatPhone } from '../shared/identity.js';

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

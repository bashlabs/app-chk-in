import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { COLLECTIONS, ACCESS_CONFIG_DOC } from '../shared/collections.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

// The rules language has no imports, so collection names are written out
// literally in firestore.rules. These tests are the seam that keeps that
// duplication honest — rename a collection and they fail immediately, instead
// of the app silently hitting the deny-all catch-all at runtime.
test('every collection has a rule', () => {
  const rules = read('firestore.rules');
  for (const name of Object.values(COLLECTIONS)) {
    assert.ok(rules.includes(`match /${name}/`), `firestore.rules has no match block for "${name}"`);
  }
});

test('the rate-limit TTL policy points at the right collection', () => {
  const indexes = JSON.parse(read('firestore.indexes.json'));
  const ttl = indexes.fieldOverrides?.find((f) => f.ttl);
  assert.ok(ttl, 'no TTL policy declared');
  assert.equal(ttl.collectionGroup, COLLECTIONS.rateLimits);
});

test('names are prefixed and Firestore-legal', () => {
  for (const name of Object.values(COLLECTIONS)) {
    assert.ok(name.startsWith('church-attendance'), `"${name}" is not namespaced`);
    // Firestore ids: no slashes, not . or .., not __reserved__, max 1500 bytes.
    assert.doesNotMatch(name, /\//, `"${name}" contains a slash`);
    assert.doesNotMatch(name, /^__.*__$/, `"${name}" uses the reserved form`);
    assert.ok(Buffer.byteLength(name) <= 1500);
  }
});

test('the config doc path is built from the config collection', () => {
  assert.equal(ACCESS_CONFIG_DOC, `${COLLECTIONS.config}/access`);
});

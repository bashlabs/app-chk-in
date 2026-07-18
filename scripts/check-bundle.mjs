/**
 * Fails the build if anything credential-shaped reached the browser bundle.
 *
 * The service-account key lives in `.env` next to `VITE_*` config that is
 * *designed* to ship to browsers. Vite only inlines `VITE_`-prefixed values, so
 * an unprefixed key can't leak — but that safety rests entirely on a naming
 * convention, and the failure is silent and catastrophic: a key in the bundle
 * is a key handed to every visitor, with full read/write on the database.
 *
 * One typo (`VITE_FIREBASE_SERVICE_ACCOUNT=...`) is all it takes. This is the
 * seatbelt for that typo, and it is verified to catch it.
 *
 * Both encodings are checked. That matters: the key is stored base64 (a .env
 * file can't hold the raw JSON's newlines), and base64 contains none of the
 * plaintext markers below — a scan for those alone silently misses the very
 * format we recommend.
 *
 * Runs automatically as part of `npm run build`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

/** Things that should never appear in a file a browser downloads. */
const MARKERS = [
  'BEGIN PRIVATE KEY',
  'BEGIN RSA PRIVATE KEY',
  '"private_key"',
  'private_key_id',
  '.iam.gserviceaccount.com',
  'service_account',
];

/**
 * Long base64 runs, which is what an encoded key looks like. Minified code has
 * plenty of similar-looking runs; they decode to noise and match nothing, so
 * false positives aren't a concern.
 */
const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/g;

const SCANNABLE = /\.(js|mjs|cjs|html|css|json|map|webmanifest)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** @returns the marker found, or null */
function findMarker(text) {
  return MARKERS.find((m) => text.includes(m)) ?? null;
}

function findEncodedMarker(text) {
  for (const run of text.match(BASE64_RUN) ?? []) {
    let decoded;
    try {
      decoded = Buffer.from(run, 'base64').toString('utf8');
    } catch {
      continue;
    }
    const marker = findMarker(decoded);
    if (marker) return marker;
  }
  return null;
}

try {
  statSync(DIST);
} catch {
  console.error(`check-bundle: no ${DIST}/ to check — run the build first.`);
  process.exit(1);
}

let leaks = 0;

for (const file of walk(DIST)) {
  if (!SCANNABLE.test(file)) continue;

  const contents = readFileSync(file, 'utf8');

  const plain = findMarker(contents);
  if (plain) {
    console.error(`\n🚨 ${file} contains "${plain}"`);
    leaks++;
  }

  const encoded = findEncodedMarker(contents);
  if (encoded) {
    console.error(`\n🚨 ${file} contains base64 that decodes to "${encoded}"`);
    leaks++;
  }
}

if (leaks) {
  console.error(
    '\nA credential has leaked into the browser bundle — every visitor would\n' +
      'get it, with full read/write on the database.\n\n' +
      'Most likely cause: a service-account value given a VITE_ prefix, which\n' +
      'tells Vite to inline it for the client. Server-side secrets must be\n' +
      'unprefixed.\n\n' +
      'Do not deploy this build. If it was ever published, rotate the key:\n' +
      'Firebase console -> Project settings -> Service accounts.\n',
  );
  process.exit(1);
}

console.log('✓ no credentials in the bundle (plaintext or base64)');

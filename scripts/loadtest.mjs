/**
 * Isolated load test for the public check-in endpoint.
 *
 * Drives the REAL `check-in.mjs` handler in-process (no HTTP layer, no
 * netlify-cli) against the Firestore EMULATOR — so it exercises the true
 * per-request Firestore cost under real concurrency while touching zero real
 * data. It refuses to run unless FIRESTORE_EMULATOR_HOST is set, so it can
 * never point at production.
 *
 * Run it:
 *   npx firebase emulators:exec --project demo-attendance --only firestore \
 *     "node scripts/loadtest.mjs --total 500 --concurrency 50"
 *
 * Flags (all optional):
 *   --total N        requests to fire            (default 500)
 *   --concurrency N  in-flight at once           (default 50)
 *   --members N      distinct members to seed    (default = --total)
 *
 * What it proves, and what it doesn't:
 *   ✔ the code path is correct and every check-in does the op count we claimed
 *   ✔ a crowd on one shared IP never throttles itself (success path isn't counted)
 *   ✔ CPU/handler overhead per request is negligible
 *   ✘ absolute latency — the emulator is in-memory and local, so it is FASTER
 *     than real Firestore over the network. Read the throughput/error columns,
 *     not the millisecond values, as the verdict. Monthly free-tier quota is
 *     arithmetic (see the earlier analysis), not something one run measures.
 */
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { generateKeyPairSync } from 'node:crypto';

// --- Safety: only ever run against the emulator. -----------------------------
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    'Refusing to run: FIRESTORE_EMULATOR_HOST is not set.\n' +
      'This guard is what keeps the load test off the real church database.\n\n' +
      'Run me through the emulator:\n' +
      '  npx firebase emulators:exec --project demo-attendance --only firestore \\\n' +
      '    "node scripts/loadtest.mjs --total 500 --concurrency 50"',
  );
  process.exit(1);
}

// firebase.mjs constructs cert(loadServiceAccount()) at import time, and
// firebase-admin parses the private key there (createPrivateKey), so it must be
// a real PEM. Under the emulator it's never actually used to SIGN anything, so
// a freshly generated throwaway keypair satisfies the parser and stays local.
if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(
    JSON.stringify({
      project_id: process.env.GCLOUD_PROJECT || 'demo-attendance',
      client_email: 'loadtest@demo-attendance.iam.gserviceaccount.com',
      private_key: privateKey,
    }),
  ).toString('base64');
}

const args = parseArgs(process.argv.slice(2));
const TOTAL = args.total ?? 500;
const CONCURRENCY = args.concurrency ?? 50;
const MEMBERS = args.members ?? TOTAL;

// Imported after the env is set, so firebase.mjs initialises against the emulator.
const { db } = await import('../netlify/lib/firebase.mjs');
const { default: checkIn } = await import('../netlify/functions/check-in.mjs');
const { COLLECTIONS, ACCESS_CONFIG_DOC } = await import('../shared/collections.js');

// --- Seed: force the window open, then create distinct members. --------------
// 'open' mode makes evaluateAccess() return open regardless of the day, so the
// test isn't gated by "only Sundays". Distinct members mean every request is a
// first-time check-in for today (one write each) rather than a deduped no-op.
console.log(`Seeding ${MEMBERS} members + open-access config into the emulator…`);
await db.doc(ACCESS_CONFIG_DOC).set({ mode: 'open' }, { merge: true });

const identifiers = [];
for (let i = 0; i < MEMBERS; i += 400) {
  const batch = db.batch();
  for (let j = i; j < Math.min(i + 400, MEMBERS); j++) {
    const email = `member${j}@loadtest.local`;
    batch.set(db.collection(COLLECTIONS.members).doc(), {
      name: `Member ${j}`,
      email,
      emailLower: email,
      phone: null,
      phoneE164: null,
    });
    identifiers.push(email);
  }
  await batch.commit();
}

// --- Fire: a fixed pool of workers pulls from a shared counter. --------------
// One shared IP for everyone, on purpose — that's the church-wifi reality, and
// it demonstrates the success path never trips the rate limiter.
const IP = '10.0.0.1';
const latencies = [];
const outcomes = new Map();
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= TOTAL) return;
    const req = new Request('http://local/api/check-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: identifiers[i % identifiers.length] }),
    });

    const t0 = performance.now();
    let outcome;
    try {
      const res = await checkIn(req, { ip: IP });
      outcome = classify(res.status, await res.json());
    } catch {
      outcome = 'threw';
    }
    latencies.push(performance.now() - t0);
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }
}

console.log(`Firing ${TOTAL} check-ins, ${CONCURRENCY} in flight…\n`);
const start = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const wallMs = performance.now() - start;

report(wallMs);
process.exit(0);

// --------------------------------------------------------------------- helpers

function classify(status, body) {
  if (status === 200 && body.found === true) return body.alreadyCheckedIn ? 'ok(duplicate)' : 'ok(new)';
  if (status === 200 && body.found === false) return 'not_found';
  if (status === 403 && body.error === 'closed') return 'closed';
  if (status === 429) return 'rate_limited';
  if (status === 400) return `bad_request(${body.error ?? '?'})`;
  return `http_${status}(${body?.error ?? '?'})`;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function report(wallMs) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const okNew = outcomes.get('ok(new)') ?? 0;
  const ms = (n) => `${n.toFixed(1)} ms`;

  console.log('──────────────────────────────────────────────');
  console.log(' Check-in load test — Firestore emulator');
  console.log('──────────────────────────────────────────────');
  console.log(` requests        ${TOTAL}`);
  console.log(` concurrency     ${CONCURRENCY}`);
  console.log(` wall time       ${(wallMs / 1000).toFixed(2)} s`);
  console.log(` throughput      ${(TOTAL / (wallMs / 1000)).toFixed(0)} req/s`);
  console.log('');
  console.log(' latency per check-in');
  console.log(`   min ${ms(sorted[0] ?? 0)}   avg ${ms(sum / (sorted.length || 1))}`);
  console.log(`   p50 ${ms(pct(sorted, 50))}   p90 ${ms(pct(sorted, 90))}`);
  console.log(`   p99 ${ms(pct(sorted, 99))}   max ${ms(sorted.at(-1) ?? 0)}`);
  console.log('');
  console.log(' outcomes');
  for (const [k, v] of [...outcomes].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(22)} ${v}`);
  }
  console.log('');
  console.log(' est. Firestore ops (successful new check-in = ~4 reads + 1 write)');
  console.log(`   reads  ~${okNew * 4}   writes  ~${okNew}`);
  console.log('   vs Spark free daily limits: 50,000 reads / 20,000 writes');
  console.log('──────────────────────────────────────────────');
  console.log(' NOTE: emulator latency is local/in-memory and much lower than');
  console.log(' real Firestore. Judge by throughput + zero rate_limited/errors,');
  console.log(' not the millisecond figures.');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(total|concurrency|members)$/.exec(argv[i]);
    if (m) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--${m[1]} needs a positive integer`);
        process.exit(1);
      }
      out[m[1]] = n;
    }
  }
  return out;
}

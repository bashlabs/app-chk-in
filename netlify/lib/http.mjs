/**
 * Shared HTTP plumbing for the check-in endpoints.
 */
import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from './firebase.mjs';
import { resolveConfig } from '../../shared/access.js';
import { ACCESS_CONFIG_DOC, COLLECTIONS } from '../../shared/collections.js';

const JSON_HEADERS = {
  'content-type': 'application/json',
  // These endpoints are per-request state; never let a CDN hold an answer.
  'cache-control': 'no-store',
};

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// A warm Netlify instance reuses this across invocations, so the access config
// — which changes rarely — isn't re-read from Firestore on every check-in. That
// read was the single biggest per-request Firestore cost on a busy Sunday. The
// short TTL is the trade: an admin opening or closing the window (or an
// emergency "close now") takes up to this long to reach already-warm instances.
const CONFIG_TTL_MS = 30_000;
/** @type {{ value: import('../../shared/access.js').AccessConfig, at: number } | null} */
let configCache = null;

export async function loadConfig() {
  const now = Date.now();
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.value;

  const snap = await db.doc(ACCESS_CONFIG_DOC).get();
  const value = resolveConfig(snap.exists ? snap.data() : undefined);
  configCache = { value, at: now };
  return value;
}

/**
 * Netlify puts the real client address in `context.ip`; the header is a
 * fallback for `netlify dev` and older runtimes.
 */
export function clientIp(req, context) {
  return (
    context?.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    null
  );
}

/** A malformed env value falls back to the default rather than becoming NaN —
 *  `count >= NaN` is always false, which would silently disable the limiter. */
function posInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const RATE_WINDOW_MS = posInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) * 60 * 1000;
/** Failed lookups per window, per IP. Generous: unregistered visitors on the
 *  church wifi legitimately miss, and they share that IP with everyone else —
 *  so on a busy Sunday a wave of not-yet-registered guests all count against the
 *  one shared IP. Env-tunable (`RATE_LIMIT_MAX_FAILURES`) so that ceiling can be
 *  raised for a service without a redeploy. Only misses count; real members who
 *  succeed never do, so the crowd itself never trips it. */
const RATE_MAX = posInt(process.env.RATE_LIMIT_MAX_FAILURES, 50);

/**
 * Only *failed* lookups are counted — never successful check-ins.
 *
 * This matters more than it looks. A whole congregation on the church wifi
 * shares one public IP (and Nigerian carriers CGNAT their mobile users onto
 * shared IPs too). If every check-in counted, the 16th person through the door
 * would be told "too many attempts" for doing nothing wrong, and the app would
 * fail hardest on a busy Sunday.
 *
 * Counting misses keeps the property we actually want. Real members succeed, so
 * a crowd never trips it. Enumeration means guessing numbers you don't know,
 * which misses nearly every time, so a scraper burns its budget almost at once.
 *
 * An attacker with a list of real numbers can still confirm them one by one
 * without being throttled — but that tells them nothing they didn't already
 * know. Discovering members is the thing this has to make expensive.
 */

/** Identify a caller without storing their address: an IP is personal data. */
const keyFor = (ip) => createHash('sha256').update(ip).digest('hex').slice(0, 32);

const refFor = (ip) => db.collection(COLLECTIONS.rateLimits).doc(keyFor(ip));

const windowLive = (data, now) => data && now - data.windowStart <= RATE_WINDOW_MS;

/** Read-only: has this IP already spent its budget of failures? */
export async function isRateLimited(ip) {
  if (!ip) return false;

  const snap = await refFor(ip).get();
  if (!snap.exists) return false;

  const data = snap.data();
  return windowLive(data, Date.now()) && data.count >= RATE_MAX;
}

/** Count one failed lookup against this IP. */
export async function recordFailedAttempt(ip) {
  if (!ip) return;

  const ref = refFor(ip);

  // A transaction, so two simultaneous misses can't both read the same count
  // and write the same increment — the exact concurrency this guards against.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : null;

    if (!windowLive(data, now)) {
      tx.set(ref, {
        windowStart: now,
        count: 1,
        // Paired with a Firestore TTL policy on `expiresAt` to self-clean.
        // Not extended on increment: the doc should die when the window does.
        expiresAt: Timestamp.fromMillis(now + RATE_WINDOW_MS),
      });
      return;
    }

    tx.update(ref, { count: FieldValue.increment(1) });
  });
}

/**
 * Optional reCAPTCHA v3 check.
 *
 * App Check attested the browser to Firebase, which no longer sits on this
 * path — so verifying the token ourselves is the equivalent control. Skipped
 * unless RECAPTCHA_SECRET_KEY is configured, so local dev needs no keys.
 *
 * @returns {Promise<boolean>} false only when a configured check actually fails
 */
export async function verifyRecaptcha(token, ip) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const data = await res.json();
    const min = Number(process.env.RECAPTCHA_MIN_SCORE ?? 0.5);
    return data.success === true && (data.score ?? 1) >= min;
  } catch {
    // Google being unreachable shouldn't lock the congregation out on a Sunday.
    return true;
  }
}

/**
 * POST /api/check-in   { identifier: string, recaptchaToken?: string }
 *
 * Looks a member up by email or phone and records their attendance.
 *
 * Deliberately returns the same shape whether or not the member exists, and
 * never echoes back any stored contact details — this endpoint is public, so
 * it must not become a way to test whether a given number is on file beyond
 * the yes/no the rate limiter allows.
 */
import { FieldValue } from 'firebase-admin/firestore';

import { evaluateAccess } from '../../shared/access.js';
import { normalizeIdentifier } from '../../shared/identity.js';
import { db } from '../lib/firebase.mjs';
import {
  clientIp,
  isRateLimited,
  json,
  loadConfig,
  recordFailedAttempt,
  verifyRecaptcha,
} from '../lib/http.mjs';
import { publicStatus } from '../lib/status.mjs';
import { COLLECTIONS } from '../../shared/collections.js';

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const ip = clientIp(req, context);

  if (await isRateLimited(ip)) {
    return json(
      { error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' },
      429,
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!(await verifyRecaptcha(body?.recaptchaToken, ip))) {
    return json({ error: 'bot_suspected', message: 'Could not verify this request. Please reload and try again.' }, 403);
  }

  const identity = normalizeIdentifier(body?.identifier);
  if (!identity) {
    // Garbage in counts: a scraper probing the endpoint looks like this, and a
    // real person mistypes once or twice, not twenty times.
    await recordFailedAttempt(ip);
    return json(
      {
        error: 'invalid_identifier',
        message: 'Please enter a valid email address or Nigerian phone number (e.g. 08031234567).',
      },
      400,
    );
  }

  const accessConfig = await loadConfig();
  const access = evaluateAccess(accessConfig, new Date());
  if (!access.open) {
    return json(
      { error: 'closed', message: accessConfig.closedMessage, status: publicStatus(accessConfig, access) },
      403,
    );
  }

  const field = identity.type === 'email' ? 'emailLower' : 'phoneE164';
  const found = await db.collection(COLLECTIONS.members).where(field, '==', identity.value).limit(1).get();

  if (found.empty) {
    // The one that matters: a miss is what walking the number space looks like.
    await recordFailedAttempt(ip);
    return json({ found: false, message: accessConfig.unknownMessage });
  }

  // Past here the lookup succeeded, so nothing is counted — a whole
  // congregation checking in from one wifi IP must never throttle itself.

  const member = found.docs[0];
  const ref = db.doc(`${COLLECTIONS.attendance}/${access.serviceDate}_${member.id}`);

  // One row per member per service date, so a double-tap doesn't double-count.
  const alreadyCheckedIn = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return true;

    tx.set(ref, {
      memberId: member.id,
      name: member.get('name') ?? null,
      serviceDate: access.serviceDate,
      checkedInAt: FieldValue.serverTimestamp(),
      via: identity.type,
    });

    // Deliberately only one write per check-in. A `lastCheckedInAt` on the
    // member doc used to live here, but nothing read it and this collection
    // already answers "when did they last come" — it was doubling the write
    // cost of every check-in, which is what the free tier meters.
    return false;
  });

  return json({
    found: true,
    alreadyCheckedIn,
    name: member.get('name') ?? null,
    serviceDate: access.serviceDate,
    message: accessConfig.successMessage,
  });
};

export const config = { path: '/api/check-in' };

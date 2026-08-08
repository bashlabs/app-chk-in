/**
 * POST /api/register   { identifier: string, name: string, recaptchaToken?: string }
 *
 * Registers someone who isn't on file yet and checks them in, in one step — so
 * a newcomer at the door doesn't have to queue at the welcome desk to be
 * counted.
 *
 * This is the only public write path into the congregation directory, so
 * everything here is shaped to keep it dull:
 *
 *   • the document id comes from the phone number, so one person can only ever
 *     occupy one document however many times they submit — resubmitting
 *     overwrites nothing and adds nothing;
 *   • an existing member is never overwritten. If the number is already on
 *     file the request degrades into an ordinary check-in, which is also the
 *     honest answer when two people share a family phone;
 *   • every record is stamped `source: 'self'`, so the office can review
 *     everything that let itself in under "Joined today";
 *   • writes are metered separately from lookups (see `isPublicWriteLimited`),
 *     because a miss costs a read and a registration costs a permanent row.
 */
import { evaluateAccess } from '../../shared/access.js';
import { memberDocId, normalizeIdentifier, normalizeName } from '../../shared/identity.js';
import { db } from '../lib/firebase.mjs';
import { recordAttendance } from '../lib/attendance.mjs';
import {
  clientIp,
  isPublicWriteLimited,
  json,
  loadConfig,
  recordFailedAttempt,
  recordPublicWrite,
  verifyRecaptcha,
} from '../lib/http.mjs';
import { publicStatus } from '../lib/status.mjs';
import { COLLECTIONS } from '../../shared/collections.js';

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const ip = clientIp(req, context);

  if (await isPublicWriteLimited(ip)) {
    return json(
      {
        error: 'rate_limited',
        message: 'Too many sign-ups from this connection. Please see the welcome desk.',
      },
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
    return json(
      { error: 'bot_suspected', message: 'Could not verify this request. Please reload and try again.' },
      403,
    );
  }

  const identity = normalizeIdentifier(body?.identifier);
  if (!identity) {
    await recordFailedAttempt(ip);
    return json(
      {
        error: 'invalid_identifier',
        message: 'Please enter a valid email address or Nigerian phone number (e.g. 08031234567).',
      },
      400,
    );
  }

  const name = normalizeName(body?.name);
  if (!name) {
    return json({ error: 'invalid_name', message: 'Please enter your full name.' }, 400);
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
  const ref = db.doc(`${COLLECTIONS.members}/${memberDocId(identity)}`);

  // The legacy lookup runs OUTSIDE the transaction, deliberately.
  //
  // A transaction that reads a *query* locks that query's range, so every
  // concurrent registration would contend with every other one — not just the
  // ones sharing a number — and a rush at the door would start failing on retry
  // exhaustion. An integration test firing 25 at once caught exactly that.
  //
  // Uniqueness doesn't depend on this read. It depends on the document id being
  // derived from the number, which turns "two people registering the same
  // number" into two writers of one document, which the transaction below
  // serialises properly. This query only catches the handful of members still
  // on file under a random id from before ids became deterministic; the worst a
  // race here can do is let one of those through as a duplicate, which
  // `npm run audit` reports.
  const legacy = (
    await db.collection(COLLECTIONS.members).where(field, '==', identity.value).limit(1).get()
  ).docs[0];
  if (legacy) {
    const alreadyCheckedIn = await recordAttendance({
      serviceDate: access.serviceDate,
      memberId: legacy.id,
      name: legacy.get('name') ?? null,
      via: identity.type,
    });
    return json({
      found: true,
      created: false,
      alreadyCheckedIn,
      name: legacy.get('name') ?? null,
      serviceDate: access.serviceDate,
      message: accessConfig.successMessage,
    });
  }

  // One document, one writer at a time. This is the guarantee that matters.
  const outcome = await db.runTransaction(async (tx) => {
    const byId = await tx.get(ref);
    if (byId.exists) return { created: false, id: byId.id, name: byId.get('name') ?? null };

    tx.set(ref, {
      name,
      email: identity.type === 'email' ? identity.value : null,
      emailLower: identity.type === 'email' ? identity.value : null,
      phone: identity.type === 'phone' ? identity.value : null,
      phoneE164: identity.type === 'phone' ? identity.value : null,
      createdAt: new Date(),
      source: 'self',
    });
    return { created: true, id: ref.id, name };
  });

  if (outcome.created) await recordPublicWrite(ip);

  const alreadyCheckedIn = await recordAttendance({
    serviceDate: access.serviceDate,
    memberId: outcome.id,
    name: outcome.name,
    via: outcome.created ? 'self' : identity.type,
  });

  return json({
    found: true,
    created: outcome.created,
    alreadyCheckedIn,
    name: outcome.name,
    serviceDate: access.serviceDate,
    message: accessConfig.successMessage,
  });
};

export const config = { path: '/api/register' };

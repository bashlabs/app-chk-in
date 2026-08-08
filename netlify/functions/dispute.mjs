/**
 * POST /api/dispute   { identifier: string, claimedName: string, recaptchaToken?: string }
 *
 * "That isn't my name." Records the correction; never applies it.
 *
 * The 21 July spreadsheet import paired a run of names against the wrong phone
 * numbers, so a member can type their own number and be greeted as somebody
 * else. Only the person holding the phone knows which of the two names is
 * right, and they are standing there at the moment it happens — this endpoint
 * captures that, and an admin decides what to do with it.
 *
 * It deliberately does NOT rename the member. A wrong name is a two-sided
 * claim: the other person may be the real owner of the number, and letting the
 * check-in screen rewrite the directory would turn one bad row into two.
 *
 * One report per number per service date (the document id sees to that), so a
 * frustrated member tapping twice doesn't produce a queue of duplicates.
 */
import { evaluateAccess } from '../../shared/access.js';
import { memberDocId, normalizeIdentifier, normalizeName } from '../../shared/identity.js';
import { db } from '../lib/firebase.mjs';
import {
  clientIp,
  isPublicWriteLimited,
  json,
  loadConfig,
  recordFailedAttempt,
  recordPublicWrite,
  verifyRecaptcha,
} from '../lib/http.mjs';
import { COLLECTIONS } from '../../shared/collections.js';

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const ip = clientIp(req, context);

  if (await isPublicWriteLimited(ip)) {
    return json({ error: 'rate_limited', message: 'Please see the welcome desk.' }, 429);
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
    return json({ error: 'invalid_identifier', message: 'Please check the number and try again.' }, 400);
  }

  const claimedName = normalizeName(body?.claimedName);
  if (!claimedName) {
    return json({ error: 'invalid_name', message: 'Please enter your full name.' }, 400);
  }

  const accessConfig = await loadConfig();
  const access = evaluateAccess(accessConfig, new Date());

  // Resolve the member here rather than trusting anything the client says about
  // who it was shown — the whole point is to capture what the app actually did.
  const field = identity.type === 'email' ? 'emailLower' : 'phoneE164';
  const found = await db.collection(COLLECTIONS.members).where(field, '==', identity.value).limit(1).get();
  const shown = found.docs[0];

  const id = `${access.serviceDate}_${memberDocId(identity)}`;
  await db.doc(`${COLLECTIONS.disputes}/${id}`).set(
    {
      [field]: identity.value,
      shownName: shown?.get('name') ?? null,
      shownMemberId: shown?.id ?? null,
      claimedName,
      serviceDate: access.serviceDate,
      reportedAt: new Date(),
      resolved: false,
    },
    { merge: true },
  );

  await recordPublicWrite(ip);

  return json({
    recorded: true,
    message: 'Thank you — we have noted it and someone will correct your record.',
  });
};

export const config = { path: '/api/dispute' };

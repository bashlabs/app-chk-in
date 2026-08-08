/**
 * The one place an attendance record is written.
 *
 * Shared by the public check-in and the self-registration endpoint so the two
 * can never drift into writing subtly different documents — the admin report
 * reads these fields positionally and a missing `via` or a differently-named
 * timestamp would quietly drop people out of the day view.
 */
import { FieldValue } from 'firebase-admin/firestore';

import { db } from './firebase.mjs';
import { COLLECTIONS } from '../../shared/collections.js';

/**
 * One document per member per service date, so a double-tap doesn't double-count.
 *
 * @param {object} args
 * @param {string} args.serviceDate  YYYY-MM-DD
 * @param {string} args.memberId     the member document id
 * @param {string|null} args.name    denormalised for the report
 * @param {'phone'|'email'|'admin'|'self'} args.via
 * @returns {Promise<boolean>} true when they were already checked in today.
 */
export async function recordAttendance({ serviceDate, memberId, name, via }) {
  const ref = db.doc(`${COLLECTIONS.attendance}/${serviceDate}_${memberId}`);

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return true;

    tx.set(ref, {
      memberId,
      name: name ?? null,
      serviceDate,
      checkedInAt: FieldValue.serverTimestamp(),
      via,
    });

    // Deliberately only one write per check-in. A `lastCheckedInAt` on the
    // member doc used to live here, but nothing read it and this collection
    // already answers "when did they last come" — it was doubling the write
    // cost of every check-in, which is what the free tier meters.
    return false;
  });
}

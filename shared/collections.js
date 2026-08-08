/**
 * Firestore collection names, in one place.
 *
 * Everything is prefixed so this app owns an obvious namespace: a bare
 * `members` collection is a name almost any other app would also want, and the
 * Firestore project may not stay single-purpose.
 *
 * Imported by the browser, the Netlify functions and the local scripts, so a
 * rename can never leave one of them reading the wrong place.
 *
 * NOTE: `firestore.rules` cannot import this — rules have no module system, so
 * the names are repeated there literally. Change both together.
 */
const PREFIX = 'church-attendance';

export const COLLECTIONS = {
  /** Congregation directory. Contact details — never client-readable. */
  members: `${PREFIX}-members`,
  /** One doc per member per service date. */
  attendance: `${PREFIX}-records`,
  /** Holds the single `access` doc. */
  config: `${PREFIX}-config`,
  /** Membership grants admin; the doc id is the Firebase Auth uid. */
  admins: `${PREFIX}-admins`,
  /** Hashed-IP throttle counters. */
  rateLimits: `${PREFIX}-rate-limits`,
  /** "That isn't my name" reports from the check-in screen. Never auto-applied. */
  disputes: `${PREFIX}-disputes`,
};

/** The one config document. */
export const ACCESS_CONFIG_DOC = `${COLLECTIONS.config}/access`;

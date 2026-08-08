/**
 * Canonical identity normalisation, shared by the web app, the Cloud Functions
 * and the seed script.
 *
 * This file is the single source of truth. `scripts/sync-shared.mjs` copies it
 * into `functions/shared/` at deploy time, because the Firebase CLI only
 * uploads the `functions/` directory.
 *
 * Phone numbers are normalised to E.164 (+234XXXXXXXXXX) so that a member
 * stored as "08031234567" is still found when they type "+234 803 123 4567".
 */

/** Nigerian mobile national numbers: 10 digits beginning 7, 8 or 9. */
const NG_MOBILE = /^[789]\d{9}$/;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * @param {unknown} input
 * @returns {string|null} E.164 phone (+234...), or null if not a valid NG mobile.
 */
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;

  let n = input.replace(/\D/g, '');
  if (!n) return null;

  // Peel prefixes in order, so mixed forms like "+2340803..." also resolve.
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('234')) n = n.slice(3);
  if (n.startsWith('0')) n = n.slice(1);

  return NG_MOBILE.test(n) ? `+234${n}` : null;
}

/**
 * @param {unknown} input
 * @returns {string|null} Lowercased, trimmed email, or null if malformed.
 */
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const e = input.trim().toLowerCase();
  return EMAIL.test(e) ? e : null;
}

/**
 * @typedef {{ type: 'email', value: string } | { type: 'phone', value: string }} Identity
 */

/**
 * Works out whether the user typed an email or a phone number and normalises it.
 *
 * @param {unknown} input
 * @returns {Identity|null} null when the input is neither a valid email nor a
 *   valid Nigerian mobile number.
 */
export function normalizeIdentifier(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  if (raw.includes('@')) {
    const value = normalizeEmail(raw);
    return value ? { type: 'email', value } : null;
  }

  const value = normalizePhone(raw);
  return value ? { type: 'phone', value } : null;
}

/**
 * The document id a member must live at.
 *
 * Derived from the contact details rather than random, so "one person, one
 * document" is a property of the database instead of something every write path
 * has to remember separately. Check-in resolves a phone with `.limit(1)`, which
 * silently picks one of a set — the only way it can never pick the wrong name is
 * for the set to be impossible to build.
 *
 * Phone digits, matching the ids `scripts/migrate-members.mjs` wrote, so the
 * office adding someone by hand, a self-registration at the door, and the import
 * script all converge on one document rather than three.
 *
 * @param {Identity} identity
 * @returns {string}
 */
export function memberDocId(identity) {
  if (identity.type === 'phone') return identity.value.replace(/\D/g, '');
  // Emails contain no '/', so they are already valid document ids. Prefixed so
  // an all-digit local part can't collide with a phone-derived id.
  return `e-${identity.value}`;
}

/**
 * Cleans a name typed by a member at the door.
 *
 * Strips control characters and the bidi marks that came through the
 * spreadsheet import (several names arrived carrying a leading U+200E), so the
 * stored value is the one an admin sees when they search for it.
 *
 * @param {unknown} input
 * @returns {string|null} the cleaned name, or null if it isn't usable.
 */
export function normalizeName(input) {
  if (typeof input !== 'string') return null;
  const n = input
    // C0/C1 control characters, then the bidi marks and embedding controls.
    // Several spreadsheet names arrived carrying a leading U+200E.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length < 2 || n.length > 80) return null;
  // Must contain an actual letter — "..." and "12345" are not names.
  return /\p{L}/u.test(n) ? n : null;
}

/**
 * Formats an E.164 Nigerian number for display: +234 803 123 4567
 *
 * @param {string} e164
 * @returns {string}
 */
export function formatPhone(e164) {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

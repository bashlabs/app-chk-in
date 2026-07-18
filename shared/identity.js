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
 * Formats an E.164 Nigerian number for display: +234 803 123 4567
 *
 * @param {string} e164
 * @returns {string}
 */
export function formatPhone(e164) {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

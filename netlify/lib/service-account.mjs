/**
 * Finds and parses the service-account key, for anything that needs to act as
 * the project rather than as a user: the Netlify functions and the local
 * scripts. Both use the same variable, so there's one secret and one name.
 *
 * This is NOT the same thing as the `VITE_FIREBASE_*` config. That config is an
 * address — it names the project and authenticates nothing, which is why it can
 * ship to the browser. This key is an identity: it bypasses every security
 * rule. It must never reach the browser, never be committed, and never go in
 * `.env` (Vite would inline it into the bundle).
 *
 * Server-only. Do not import from `src/`.
 */
import { readFileSync } from 'node:fs';

function parse(raw, source) {
  const value = raw.trim();
  let parsed;

  try {
    // Base64 is the normal form: a .env file can't hold the raw JSON, whose
    // private_key contains real newlines. Raw JSON is accepted too, for
    // pasting straight into a hosting UI where newlines survive.
    parsed = JSON.parse(value.startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new Error(
      `${source} could not be decoded.\n` +
        'Expected base64 of the service-account JSON (or the raw JSON itself).\n' +
        '  base64 -i key.json | tr -d \'\\n\'      # macOS\n' +
        '  base64 -w0 key.json                    # Linux',
    );
  }

  if (!parsed.project_id || !parsed.private_key) {
    throw new Error(`${source} does not look like a service-account key (no project_id/private_key).`);
  }
  return parsed;
}

const HELP = `
Set FIREBASE_SERVICE_ACCOUNT to your service-account key, base64-encoded.

  1. Firebase console -> Project settings -> Service accounts
       -> Generate new private key
  2. base64 -i key.json | tr -d '\\n'        (Linux: base64 -w0 key.json)
  3. Paste it into .env as FIREBASE_SERVICE_ACCOUNT=...
     and into Netlify -> Site configuration -> Environment variables.

Never give it a VITE_ prefix: that would inline it into the browser bundle.

This is not the same as your VITE_FIREBASE_* config. That config names the
project and authenticates nothing; this key proves you own it and bypasses
every security rule. GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json also
works if you already use the Google standard.
`;

/**
 * @returns the parsed service-account key.
 * @throws with actionable guidance when no usable credential is present.
 */
export function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) return parse(inline, 'FIREBASE_SERVICE_ACCOUNT');

  // The Google-standard variable, kept as a fallback. We read the file rather
  // than lean on applicationDefault() so the project id can come from the key
  // itself — one less thing to configure, and one less thing to get wrong.
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS points at ${path}, which could not be read.`);
    }
    return parse(raw, `The key at ${path}`);
  }

  throw new Error(`No Firebase credentials found.\n${HELP}`);
}

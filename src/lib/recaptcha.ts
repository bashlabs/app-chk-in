/**
 * reCAPTCHA v3, loaded lazily and only if a site key is configured.
 *
 * This replaces Firebase App Check: the check-in endpoint is ours now, not
 * Firebase's, so the Netlify function verifies this token with Google itself.
 * With no key set (local dev), every call resolves to undefined and the server
 * skips the check.
 */
const SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;

declare global {
  interface Window {
    grecaptcha?: {
      ready(cb: () => void): void;
      execute(siteKey: string, opts: { action: string }): Promise<string>;
    };
  }
}

let loader: Promise<void> | null = null;

function loadScript(): Promise<void> {
  loader ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${SITE_KEY}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('reCAPTCHA failed to load'));
    document.head.appendChild(script);
  });
  return loader;
}

export async function recaptchaToken(action = 'check_in'): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;

  try {
    await loadScript();
    const grecaptcha = window.grecaptcha;
    if (!grecaptcha) return undefined;

    await new Promise<void>((resolve) => grecaptcha.ready(resolve));
    return await grecaptcha.execute(SITE_KEY, { action });
  } catch {
    // Returning undefined means the server rejects the attempt once
    // RECAPTCHA_SECRET_KEY is set — it has to, or a bot would just omit the
    // token. So an ad blocker that eats this script locks that person out.
    // That's the cost of enabling reCAPTCHA; see the README's anti-spam note.
    return undefined;
  }
}

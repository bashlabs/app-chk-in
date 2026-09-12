import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

import { netlifyFunctionsDev } from './netlify/vite-dev';

/**
 * Server-side secrets that may live in `.env` for convenience.
 *
 * Vite only exposes `VITE_`-prefixed variables to the browser, so these never
 * reach the bundle (`npm run build` re-checks that). But Vite also doesn't put
 * unprefixed variables into `process.env`, so the dev-time API middleware can't
 * see them either — this bridges that gap, letting a local run read the same
 * names the deployed function reads from Netlify's environment.
 */
const SERVER_ONLY = [
  'FIREBASE_SERVICE_ACCOUNT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'RECAPTCHA_SECRET_KEY',
  'RECAPTCHA_MIN_SCORE',
];

export default defineConfig(({ mode }) => {
  // '' = no prefix filter, i.e. load everything, not just VITE_*.
  const env = loadEnv(mode, process.cwd(), '');
  for (const key of SERVER_ONLY) {
    // A real shell variable wins over .env.
    if (!process.env[key] && env[key]) process.env[key] = env[key];
  }

  return {
  plugins: [
    react(),
    netlifyFunctionsDev(),
    VitePWA({
      /*
       * This app has been replaced by the foldmetric check-in project, and `/` now
       * redirects there (see netlify.toml).
       *
       * A redirect alone would not reach the people it most needs to. Returning
       * members have a service worker installed from previous Sundays, and it
       * precaches index.html — so it answers their navigation from cache and the
       * redirect is never requested. `selfDestroying` replaces sw.js with one that
       * unregisters itself and empties those caches, which is what lets the
       * congregation's phones reach the new address at all.
       */
      selfDestroying: true,
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Church Attendance Check-In',
        short_name: 'Check-In',
        description: 'Sunday service attendance check-in',
        theme_color: '#c2410c',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Never serve a cached check-in result: every lookup must reach the
        // server, which is what enforces the Sunday gate.
        navigateFallbackDenylist: [/^\/__/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/(firestore|identitytoolkit)\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          // The check-in API is same-origin now, so the service worker would
          // happily precache it. It must never be cached: every lookup has to
          // reach the server, which is what enforces the Sunday gate.
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  };
});

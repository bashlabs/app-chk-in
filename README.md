# Church Attendance Check-In

A progressive web app where members check in by email or phone number on a
Sunday. It confirms them, records attendance, and — the actual point — gives the
office a list of **who wasn't there**.

- **Check-in page** (`/`) — one field, accepts any Nigerian phone format.
- **Admin** (`/admin`) — attendance by day/week/month, member management, and an
  access page that controls when check-in is open.

## The attendance report

Pick **Day**, **Week** or **Month**, then page through with the arrows.

- **Day** — who checked in, and at what time.
- **Week / Month** — an `x of y` count per member plus the dates they came, so a
  drift ("came 1 of 4 Sundays") is visible at a glance.

The **Not in church** tab is the one that matters. On a single day it's who
missed that service; across a week or month it's who didn't come to a *single*
service — the follow-up list. Both tabs export to CSV, and the week/month export
has one column per service date so you can see whether three misses were
consecutive or scattered.

"Services" counts the dates anyone actually checked in on, so a cancelled
service doesn't count against everybody's ratio.

## Architecture

Hosted on **Netlify**; **Firestore** is the database. There are no Firebase
Cloud Functions, so **no Blaze plan and no billing account** — Firestore alone
runs on the free Spark tier.

| Piece | Runs on | Notes |
| --- | --- | --- |
| Check-in page + admin SPA | Netlify (static) | `dist/` |
| `/api/access-status`, `/api/check-in` | Netlify Functions | [`netlify/functions/`](netlify/functions) |
| Database + admin auth | Firebase | Firestore + Email/Password |

The check-in page loads **no Firebase SDK at all** — it only calls our own
`/api/*`. Firestore and Auth are lazy-loaded, and only for `/admin`. That's why
the page the congregation opens on church wifi is ~77 kB gzipped rather than
~250 kB.

## How the hard parts work

**Phone formats.** `+2347031234567`, `2347031234567`, `07031234567` and
`7031234567` are the same person. Everything is normalised to E.164 (`+234…`) by
[`shared/identity.js`](shared/identity.js) — at write time *and* lookup time, so
the two always agree. Both the browser and the functions import that one file.

**The Sunday rule is enforced on the server.** A browser-side "is it Sunday?"
check reads the *device* clock, which the user controls — changing your phone's
date would defeat it. So [`shared/access.js`](shared/access.js) decides, using
the server clock in `Africa/Lagos`, inside the Netlify function. The UI asks the
server what to render; it never decides for itself.

**Members are never client-readable.** The whole congregation's contact details
live in `members`. If the browser could query that collection, the check-in
lookup would double as a way to harvest the directory. So the public path goes
through the `check-in` function, which uses the Admin SDK and bypasses rules;
the rules themselves deny all client access. See
[`firestore.rules`](firestore.rules).

## Setup

### 1. Create the Firebase project

In the [Firebase console](https://console.firebase.google.com): create a
project, add a **Web app**, then enable

- **Firestore Database** (production mode)
- **Authentication → Sign-in method → Email/Password** (for admins only)

The free **Spark** plan is enough — nothing here needs billing.

### 2. Configure the client

```bash
cp .env.example .env    # fill in from Project settings → General → Your apps
npm install
```

The `VITE_FIREBASE_*` values are not secrets — they ship in the client bundle by
design, and only the admin screens use them. The security rules protect the data.

### 3. Deploy the Firestore rules

The rules are the only thing that still goes to Firebase:

```bash
npx firebase login
npx firebase use --add        # select your project
npm run deploy:rules
```

### 4. Get a service-account key

Firebase console → **Project settings → Service accounts → Generate new private
key**. This downloads a JSON file.

**Why this is needed when you already have the `VITE_FIREBASE_*` config:** they
do different jobs. The config is an *address* — it names the project and
authenticates nothing, which is exactly why it's safe in the browser bundle.
This key is an *identity*: it proves you own the project, which lets the Admin
SDK bypass the security rules. The server needs that bypass to read
`church-attendance-members` (a collection no client may read) and to write
`church-attendance-admins` (which is `allow write: if false` for everyone). No
value in the client config can grant that, by design.

> **This one _is_ a secret.** It bypasses every rule you wrote. Never commit it.
> `.env` is gitignored and safe (see below); `.env.example` is committed, so it
> only ever holds a blank.

Base64-encode it onto one line — a `.env` file can't hold the raw JSON, because
`private_key` contains real newlines:

```bash
base64 -i ~/Downloads/key.json | tr -d '\n' | pbcopy   # macOS
base64 -w0 key.json                                    # Linux
```

Paste it into `.env` as `FIREBASE_SERVICE_ACCOUNT=…`, and into **Netlify → Site
configuration → Environment variables**. One variable covers the functions and
the local scripts, and the project id is read out of the key, so there's nothing
else to set. `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` also works if
you prefer the Google standard.

**Why `.env` is safe for this, with one rule.** Vite only exposes
`VITE_`-prefixed variables to the browser — that prefix is exactly what makes a
value public. An unprefixed `FIREBASE_SERVICE_ACCOUNT` never reaches the bundle.
So the one rule is: **never give a secret a `VITE_` prefix.**

That rule is a naming convention, and the failure would be silent and total, so
`npm run build` re-checks it: [`scripts/check-bundle.mjs`](scripts/check-bundle.mjs)
scans `dist/` and fails the build if a credential appears — decoding base64
runs too, since an encoded key contains none of the plaintext markers a naive
scan would look for.

### 5. Deploy to Netlify

Push the repo to GitHub, then in Netlify: **Add new site → Import an existing
project**. [`netlify.toml`](netlify.toml) already sets the build command, publish
directory and functions directory, so the defaults are correct.

Under **Site configuration → Environment variables**, add:

| Variable | Value |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | the same base64 string as your `.env` |
| `VITE_FIREBASE_*` | the same values as your `.env` |
| `RECAPTCHA_SECRET_KEY` | optional — see Anti-spam |

Deploys happen on push. For a one-off from your machine:
`npx netlify-cli deploy --prod`.

### 6. Seed and create your admin

Reads `FIREBASE_SERVICE_ACCOUNT` from `.env` — nothing else to set, since the
project id comes from the key:

```bash
# FIREBASE_SERVICE_ACCOUNT comes from .env (see step 4)

npm run seed                          # the access config only
npm run seed -- --demo                # ...plus sample members and attendance

npm run create-admin -- you@church.ng            # generates a password
npm run create-admin -- you@church.ng 'secret'   # or choose one
```

The scripts print which project they're writing to and warn when it's live, so
you can catch a wrong key before it writes anything.

`create-admin` creates the Firebase Auth account if it doesn't exist and writes
the `church-attendance-admins/{uid}` doc the rules check. Re-running it on an
existing account grants admin without touching the password. A generated
password is printed once and stored nowhere — save it, then change it after
first sign-in.

Granting admin is deliberately out of band — there's no "make admin" button in
the app, so a compromised admin session can't mint more admins. Revoke by
deleting that document.

Then sign in at `/admin`, add your members under **Members** (one at a time or
via CSV), and check the **Access** page.

**Don't leave the demo data in a real project** — `--demo` writes eight
fictional members. They're all prefixed `demo-`, so they're easy to spot and
delete under **Members**.

## Local development

There are no emulators — local development runs against your real Firebase
project.

```bash
# FIREBASE_SERVICE_ACCOUNT comes from .env (see Setup step 4)
npm run dev
```

`npm run dev` serves the Netlify functions itself, via a small Vite middleware
([`netlify/vite-dev.ts`](netlify/vite-dev.ts)) that mounts the same handler
files at `/api/*`. No netlify-cli needed — the code you exercise locally is the
code that ships.

Without the key the page still loads, but `/api/*` returns a 500 telling you
what to set. `.env` supplies the client config for the admin screens.

> **Everything you do locally hits live data.** A check-in you make while
> testing is a real attendance record; `npm run seed -- --demo` writes real
> members. Demo ids are prefixed `demo-` so you can find and delete them.
>
> If that becomes uncomfortable, the usual fix is a second Firebase project
> (`abule-egba-members-dev`) with its own key — same code, throwaway data, and
> still free on Spark.

Since check-in only opens on Sundays, use the **Access** page to set mode to
*Force open* when testing midweek — and remember to set it back.

```bash
npm test            # phone normalisation, the access gate, period maths
npm run build       # typecheck + production bundle
```

## Anti-spam

Layered, because no single control is enough:

| Control | Where | Notes |
| --- | --- | --- |
| Sunday-only schedule | server | Device clock can't affect it |
| Service time window | server | Optional; the tightest real control |
| Force open / force closed | Access page | Kill switch for abuse |
| One record per member per day | server | Double-taps can't inflate counts |
| Per-IP rate limit | server | 20 **failed** lookups / 10 min, IPs stored hashed |
| reCAPTCHA v3 | client + server | **Off by default — turn it on** |

### Why the rate limit counts only failures

The check-in endpoint is public by necessity, which makes it an enumeration
oracle: post a number, learn whether that person is a member. Nigerian mobile
numbers are a walkable space, so without a throttle a script could rebuild the
whole directory — the thing the Firestore rules exist to prevent.

But everyone at church shares one public IP (church wifi, and carrier CGNAT for
mobile data). If every check-in counted, the 16th person through the door would
be told "too many attempts" for doing nothing wrong.

So only *failed* lookups count. Real members succeed, so a crowd never throttles
itself; enumeration means guessing numbers you don't know, which misses nearly
every time and burns the budget almost at once.

**The residual trade-off:** once an IP is blocked, everyone on it is blocked —
real members included, for up to 10 minutes. That's deliberate. Letting hits
through while blocked would let an attacker read `found` vs `429` and carry on
enumerating, which defeats the whole control. It also means ~20 unregistered
visitors on the church wifi inside 10 minutes could briefly lock out the
building.

Per-IP limiting can't do better than this behind NAT — it can't tell twenty
visitors from one scraper. **reCAPTCHA is the control that actually
distinguishes them**, per-client rather than per-IP, which is the real reason to
turn it on before a busy Sunday.

To enable reCAPTCHA: register the site at
[google.com/recaptcha](https://www.google.com/recaptcha/admin) (v3), then set
`VITE_RECAPTCHA_SITE_KEY` (public, client) and `RECAPTCHA_SECRET_KEY` (secret,
Netlify env). With no secret set the check is skipped entirely.

Firebase App Check used to cover this. It no longer applies: the check-in
endpoint is ours, not Firebase's, so [`netlify/lib/http.mjs`](netlify/lib/http.mjs)
verifies the token with Google directly.

One trade-off worth knowing before you switch it on: once the secret is set, a
request with **no** token is rejected — it has to be, or a bot would simply omit
it. So an ad blocker that eats Google's script locks that person out. Failing
the other way (allowing missing tokens) would make the control decorative. If
Google is unreachable from the *server*, we fail open, so an outage at their end
can't shut the door on a Sunday.

Also worth setting: a **TTL policy** on `rateLimits.expiresAt` so counters clean
themselves up (`firestore.indexes.json` declares it; confirm under Firestore →
TTL).

## Data model

Every collection is prefixed `church-attendance-`, so the app owns an obvious
namespace and can share a Firestore project without fighting over a name as
generic as `members`. The names live in
[`shared/collections.js`](shared/collections.js) — import them, never hardcode.

`firestore.rules` is the one place that repeats them literally (rules have no
imports). A test asserts every collection has a matching rule, so a rename
can't silently half-land.

| Collection | Written by | Read by |
| --- | --- | --- |
| `church-attendance-members` | admins | `check-in` (Admin SDK), admins |
| `church-attendance-records` | `check-in` only | admins |
| `church-attendance-config` | admins | the API, admins |
| `church-attendance-admins` | `create-admin` script | rules, the signed-in user |
| `church-attendance-rate-limits` | `check-in` only | nobody |

A member document:

```js
{
  name: 'Ada Obi',
  email: 'ada@example.com',      // display
  emailLower: 'ada@example.com', // queried
  phone: '0803 123 4567',        // display, as typed
  phoneE164: '+2348031234567',   // queried
}
```

Attendance ids are `${serviceDate}_${memberId}`, which is what makes check-in
idempotent for the day.

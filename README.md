# QuoteCraft

An embeddable instant-quote calculator for home-service businesses, sold as a
multi-tenant SaaS.

A cleaning company (or lawn crew, or pressure-washing outfit) signs up, sets
their rates, and pastes one line of code into their website. Visitors price
their own job in seconds; every visitor who sees a price is asked for their
details, and those leads land in a dashboard and get pushed to the business's
CRM by webhook.

The product is not the arithmetic. The product is **lead capture** — the
calculator is the thing that makes a stranger hand over their phone number.

```
┌──────────┐   embed.js    ┌──────────┐   POST lead   ┌──────────┐   webhook   ┌──────┐
│ customer │ ────────────▶ │  widget  │ ────────────▶ │  server  │ ──────────▶ │ CRM  │
│ (visitor)│   iframe      │  (calc)  │               │ (SQLite) │             └──────┘
└──────────┘               └──────────┘               └────┬─────┘
                                                           │
                                                      ┌────▼─────┐
                                                      │dashboard │  ← the business
                                                      └──────────┘
```

---

## Running it

Requires Node 18+ (the server uses the built-in `fetch`).

```bash
npm install
npm run seed     # creates the demo tenant and some sample leads
npm start        # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Same, with `--watch` |
| `npm run seed` | Create/refresh the demo tenant (idempotent) |
| `npm test` | Run the pricing-engine test suite |
| `npm run build` | Build the static `dist/` for Cloudflare Pages |
| `npm run preview` | Build, then serve `dist/` through Wrangler |

**Demo login:** `demo@quotecraft.app` / `demo1234`
**Demo widget:** <http://localhost:3000/w/maple-moss-cleaning>
**Demo embed on a fake site:** <http://localhost:3000/demo>

There is no build step for the server. No bundler, no framework, no
transpiler — the browser gets the same files that are on disk.

---

## Deploying to Cloudflare Pages

`npm run build` produces a static `dist/` (15 files, ~204 KB) that deploys to
Pages, well inside its 20,000-file / 25 MiB-per-file limits.

```bash
npm run build
npx wrangler pages deploy dist
```

**The backend does not go with it.** Cloudflare Workers cannot run this server
at any bundle size — the blockers are categorical, not size-related:

| Code | Why it can't run on Workers |
|---|---|
| `server/db.js` — `better-sqlite3` | Native C++ addon; no V8 isolate support |
| `server/index.js` — `express` | Needs Node's `http` server and `net` sockets |
| `server/index.js:33` — `fs.readdirSync` | No filesystem at runtime |
| `server/index.js:445+` — `express.static` | Same |

(The 3 MB gzipped Worker limit is a red herring here: `node_modules` is 81 MB,
but even a perfectly tree-shaken bundle would still fail on the above.)

So the static build keeps the calculator and drops the SaaS:

| Works | Gone |
|---|---|
| Pricing engine, all 3 verticals | Tenant accounts, signup, login |
| Widget + iframe embed, auto-height | Lead capture and storage |
| English/Spanish, recurring discounts | Dashboard, CSV export, stats |
| Standalone calculator at `/calculator/` | CRM webhooks |

`shared/engine.js` is already UMD, so the browser prices jobs with no server
and no network round-trip — `build-static.js` bakes the vertical configs into
`config.js` in place of `GET /api/public/config/:slug`.

Backend-only routes (`/login`, `/signup`, `/app`, `/api/*`) redirect to a page
that says so, rather than serving forms that silently fail. The lead form still
renders, but tells the visitor plainly that nothing was transmitted — it does
not fake a submission.

Nothing in the source tree is modified by the build; every transform is applied
on the way into `dist/`, so `npm start` keeps running the real server.

To deploy the full product instead, use a Node host (Fly.io, Render, Railway)
with a persistent volume for `data/quotecraft.db`.

---

## The pricing model

Everything is priced in **crew-minutes**, then converted to money at the
tenant's hourly rate. This is the single decision that makes the engine
vertical-agnostic: a lawn crew and a cleaning crew disagree about what a job
*is*, but they both sell time.

Order of operations, and the order matters:

```
1. base minutes  = size tier + every modifier
2. × priceFactor           (global thumb-on-the-scale)
3. × service multiplier    (standard / deep / move-out …)
4. → price = minutes / 60 × hourlyRate
5. × frequency multiplier  (recurring discount)
6. clamp to minimumPrice   ← service only
7. + add-ons               ← stacked on top, never discounted, never clamped
```

**Step 6 before step 7 is the rule people get wrong.** The minimum exists to
cover the cost of rolling a truck to the door. It should not swallow a $50 oven
clean the customer explicitly asked for and expects to pay extra for. A $90
service that clamps to a $140 minimum, plus a $50 add-on, is **$190** — not
$140.

Two more deliberate choices:

- **Tapering modifiers.** A `curve` array is a *cumulative* lookup:
  `curve[n]` is the total minutes for `n` units. That lets the 4th bathroom
  cost less than the 1st, because the crew only sets up once. Modifiers can
  instead use a flat `minutesEach` when that's easier to reason about.
- **Custom tiers.** A tier with `"custom": true` shows a "let's talk" message
  instead of a number. A 6,000 sq ft house varies too much to price
  sight-unseen, and an honest refusal beats a confident number that loses
  money on the job.

### Server-side truth

`POST /api/public/quote/:slug` and `POST /api/public/lead/:slug` both recompute
the quote server-side from the submitted *inputs*. The client's number is never
trusted, so nobody can open devtools and book a $2,000 job for $9.

---

## Layout

```
shared/engine.js          The pricing engine. UMD — same file runs in Node
                          (server, tests) and the browser (instant widget
                          feedback). One source of truth for the maths.

verticals/*.json          Trade presets. A new vertical is a config file,
                          not code.

server/
  index.js                Express app: auth, dashboard API, public widget API,
                          webhook delivery, static routes.
  db.js                   SQLite schema + helpers (better-sqlite3, WAL).
  auth.js                 bcrypt hashing, opaque session tokens, middleware.
  seed.js                 Demo tenant.

widget/
  widget.html/.js         The calculator itself. Renders entirely from tenant
                          config — knows nothing about any specific trade.
  embed.js                The one-line loader customers paste.

public/
  index.html              Marketing page
  signup / login / demo / 404
  assets/theme.css        Design system ("Plum & Apricot")
  app/dashboard.*         The tenant dashboard

test/engine.test.js       21 tests, no framework.
```

### Why an iframe

`embed.js` mounts the widget in an iframe rather than injecting markup, and
`postMessage`s its height to the parent so the frame stays exactly as tall as
its content.

This costs a little elegance and buys the single most common support complaint
away in both directions: the host page's CSS can never break the widget, and
the widget's CSS can never break the host page. Every embeddable tool that
injects markup eventually gets a ticket that reads "your calculator broke my
footer."

### Why sessions, not JWTs

Sessions are opaque 32-byte random tokens in an httpOnly cookie, checked
against a `sessions` table. A JWT would save a database read per request and
cost the ability to revoke. For a product where a compromised account leaks a
customer list, revocability is worth more than the read.

---

## Adding a new vertical

No code. Drop a JSON file in `verticals/` — it's picked up on server start and
appears in the signup picker.

```jsonc
{
  "vertical": "window-cleaning",
  "name": "Window Cleaning",
  "tagline": "Interior and exterior, homes and storefronts",
  "icon": "droplet",              // sparkle | leaf | droplet | beaker | box | tool

  "currency": "USD",
  "hourlyRate": 75,               // what one hour of crew time is worth
  "priceFactor": 1,               // global multiplier; 1.10 = everything +10%
  "minimumPrice": 120,            // covers getting the van there
  "roundTo": 5,                   // round quotes to the nearest $5
  "crewSize": 2,                  // for the "how long will it take" estimate
  "rangeBufferMinutes": 60,       // width of the optional from–to band

  "sizeLabel": "How many windows?",
  "sizeTiers": [
    { "id": "s0", "label": "Up to 10", "minutes": 60 },
    { "id": "s1", "label": "11 – 20",  "minutes": 95 },
    { "id": "s2", "label": "40+", "minutes": 0, "custom": true,
      "customMessage": "Send your details and we'll take a look." }
  ],

  "modifiers": [
    { "id": "storeys", "label": "Storeys", "min": 1, "max": 3, "default": 1,
      "curve": [0, 0, 35, 80] },              // cumulative: 2 storeys = +35 min
    { "id": "screens", "label": "Screens", "min": 0, "max": 30, "default": 0,
      "minutesEach": 3 }                       // or a flat per-unit rate
  ],

  "services": [
    { "id": "exterior", "label": "Exterior only", "blurb": "Outside glass",
      "multiplier": 1, "allowRecurring": true },
    { "id": "both", "label": "Inside & out", "blurb": "Every pane",
      "multiplier": 1.7, "allowRecurring": true }
  ],

  "frequencies": [
    { "id": "quarterly", "label": "Every 3 months", "discount": 0.12 },
    { "id": "onetime",   "label": "One time",       "discount": 0 }
  ],

  "addons": [
    { "id": "tracks", "label": "Sills & tracks", "price": 45, "minutes": 30 }
  ]
}
```

Notes:

- Keep one service at `"multiplier": 1` — it's your baseline, and every other
  multiplier is "how much longer than that."
- `allowRecurring: false` makes the widget quietly snap to one-time when that
  service is picked. You don't want to sell a weekly move-out clean.
- Add-on `minutes` only affect the duration estimate shown to the customer;
  the price is the flat amount. Keep them roughly honest so the crew's day
  doesn't get oversold.
- `validateConfig()` in the engine guards all of this — bad pricing config is
  silent revenue loss, and an hourly rate of `0` quotes every job at the
  minimum until someone notices at the end of the month.

Then: `npm test` and check the numbers land where you expect.

---

## API

Tenant endpoints take the session cookie. Public endpoints are CORS-open by
design — they're called from the customer's own website.

**Auth**

| | |
|---|---|
| `POST /api/auth/signup` | `{email, password, businessName, vertical}` |
| `POST /api/auth/login` | `{email, password}` |
| `POST /api/auth/logout` | |
| `GET /api/auth/me` | |

**Dashboard** (session required)

| | |
|---|---|
| `GET /api/verticals` | Available trade presets |
| `GET \| PUT /api/config` | Read/save the tenant's whole config |
| `POST /api/config/reset` | Reload a preset, discarding pricing edits |
| `GET /api/leads` | |
| `PATCH /api/leads/:id` | `{status: new\|contacted\|won\|lost}` |
| `GET /api/leads.csv` | Export |
| `GET /api/stats` | Pipeline, counts, view→lead conversion |
| `POST /api/webhook/test` | Fire a fake lead at a URL |

**Public** (called by the widget)

| | |
|---|---|
| `GET /api/public/config/:slug` | Config + branding for a tenant |
| `POST /api/public/quote/:slug` | Recompute a quote server-side |
| `POST /api/public/lead/:slug` | Submit a lead |

### Webhook payload

Fire-and-forget with one retry and an 8-second timeout; delivery state is
recorded on the lead (`delivered`, `failed_<status>`, `failed`).

```json
{
  "event": "lead.created",
  "business": "Maple & Moss Cleaning",
  "contact": { "name": "…", "email": "…", "phone": "…", "address": "…", "note": "…" },
  "quote":   { "total": 284, "currency": "USD", "service": "Standard Clean",
               "frequency": "Every 2 weeks", "durationMinutes": 200, "lines": [] },
  "sourceUrl": "https://theirsite.com/pricing"
}
```

---

## Embedding

```html
<script src="https://yourdomain.com/embed.js" data-quotecraft="your-slug"></script>
```

Optional attributes:

| | |
|---|---|
| `data-target="#quote-here"` | Mount into that element instead of in place |
| `data-max-width="1100px"` | Widen or narrow the calculator |

The loader dispatches a `quotecraft:lead` event on `window` when someone
submits, and pings `gtag` / `fbq` automatically if they're present — so ad
platforms can optimise for real leads rather than pageviews.

---

## Spam and abuse

- **Honeypot field.** Off-screen, never focusable. Filled in ⇒ the submission
  is discarded silently with a `200`. Bots don't get to learn they were caught.
- **Rate limits.** In-memory, per IP: signup, login and lead submission.
- **Control-character stripping.** Names and addresses are stripped of
  ` -` and `` — they have no business in a name, and they're
  what header- and log-injection tricks rely on.
- **Origin-checked postMessage.** The embed loader ignores messages that don't
  come from its own origin.

---

## Design

The theme is "Plum & Apricot" — deep plum ink on warm paper, with apricot
carrying the CTAs that SaaS blue usually would. Fraunces for display, Inter for
anything read quickly. The palette is warm-neutral on purpose: warm greys next
to plum read as considered; cool greys next to plum read as unfinished.

All of it lives in `public/assets/theme.css` as custom properties. Tenants
override one variable — their accent colour — and the widget shades it for
hover and active states, so a business's calculator reads as part of their site
rather than a bolted-on third-party tool.

---

## Not built

Deliberately out of scope, listed so nobody assumes otherwise:

- **Billing.** Plans are shown on the marketing page and stored on the tenant
  row; there is no Stripe integration. Every account is on `trial`.
- **Transactional email.** `notifyEmail` is stored and included in the webhook
  payload, but nothing is sent. Wire up Postmark/Resend/SES at the same place
  `forwardToWebhook()` is called.
- **Multiple calculators per account.** The schema is one config per tenant.
  The Pro/Agency plans on the pricing page assume this changes.
- **Password reset.**
- **PDF quotes.** The original inspiration generates one client-side; here the
  quote goes out by email/webhook instead.

## Legal note

`index.html` in the project root is an earlier standalone red/white rebuild of
the page that inspired this project, kept for reference. Its coefficient tables
and checklist copy were taken from that source and **should not be shipped** —
they are someone else's pricing and someone else's words.

Nothing in `verticals/`, `shared/engine.js` or anywhere else in the SaaS derives
from it. Those coefficients are original and were built from minutes × rate.

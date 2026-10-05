# Kitty on Netlify

Group buying for local shops: a Vendor Connect marketplace with decentralized checkout redirection. Shoppers pay each vendor directly on the payment provider's hosted checkout; Kitty orchestrates the group, authorizes every cart, and captures all of them together or none.

This is the production version of the Kitty prototype. Stripe Connect is the first real provider; PayPal and Adyen plug in behind the same adapter interface.

## How the architecture maps to this repo

| Architecture piece | Where it lives |
|---|---|
| Shopper app and vendor portal | `public/` (static, served from Netlify's CDN) |
| Data model (users, vendors, connections, items, group orders, carts, attempts, ledger, webhook inbox, deliveries) | `netlify/database/migrations/` (Netlify Database, Postgres) |
| API (`/api/*`) | `netlify/functions/api.ts` |
| Vendor Connect | `src/services/connect.ts` |
| Checkout Router and signed, single-use return links | `src/services/checkout.ts` |
| Provider adapter contract | `src/lib/providers/types.ts` |
| Stripe Connect adapter | `src/lib/providers/stripe.ts` |
| Webhook ingress (verify, store once, answer fast) | `netlify/functions/stripe-webhook.ts` → `src/services/events.ts` |
| Webhook processing and group capture (up to 15 min) | `netlify/functions/process-background.ts` → `src/services/capture.ts` |
| Deadlines, lapsed holds, stuck captures, courier polling (every 10 min) | `netlify/functions/sweep.ts` |
| Nightly reconciliation against the provider | `netlify/functions/reconcile.ts` |
| Nearby discovery, area limits, similar-group detection, alerts | `src/services/nearby.ts`, `src/lib/geo.ts`, `src/lib/similar.ts` |
| In-app notifications | `src/services/notifications.ts` |
| Delivery fan-out (one courier job per cart) | `src/services/delivery.ts`, `src/lib/couriers/` |
| Sign-in | Auth0 (or any OIDC provider with a JWKS), verified in `src/lib/auth.ts` |

Key behaviors:

- **Money flow.** The vendor is merchant of record. Charges are created on the vendor's Stripe account, and Kitty takes an application fee. Kitty never holds funds and never sees card data.
- **Charging the group.** A group is charged only when every cart has a live authorization. If one capture fails, the carts already captured are refunded and the remaining holds are voided.
- **Source of truth.** Payment state changes only through verified webhooks. The browser's return from checkout just updates the screen.
- **Retry safety.** Every provider call carries an idempotency key, so retries and resumed runs never double-charge.
- **Address privacy.** Shopper addresses and phone numbers are encrypted at rest with AES-256-GCM. Only the shopper, the group's vendor and the courier dispatch can read them.

## Group buys near you

Open groups are local: a shopper only sees and can join groups whose area covers them.

- **Location.** Shoppers share their browser location, or enter a postal code when `MAPBOX_TOKEN` is set. Coordinates are rounded to about 1 km before they're stored, and other shoppers only ever see a rounded distance and an optional area name like "Uptown".
- **Area.** The initiator picks who can see and join (2, 5, 10 or 25 km from where they started it). The API enforces it: the nearby list, opening a group by link, and joining all check the distance.
- **Similar groups.** Before a group is created, Kitty looks for open groups nearby for the same item, or a product with a similar name from any shop. If it finds any, the would-be initiator sees them with a one-click join. They can still start their own, and if they do, the initiators of the similar groups are notified.
- **Timely completion.** Every group has a fill-by deadline (24 hours, 3 days or a week). The 10-minute sweep closes a group that reaches its deadline with at least 2 shoppers, splitting the item evenly among them, and cancels it otherwise. The nearby list puts groups closest to filling and soonest to close first.
- **Notifications.** Neighbors who turn on alerts hear about new groups within their alert distance. Members hear when a group closes and it's time to check out, when a card hold expires, and when a group is cancelled. These are in-app (the bell); email or push can read from the same `notification` table.

Location comes from the shopper's device, so a determined user could fake it. For local group buys the cost of that is low, since every cart still pays in full and delivery goes to the address they give, but don't use the area check as a security boundary.

## Setup

### 1. Netlify site and database

```bash
npm install
npm install -g netlify-cli@latest      # Netlify Database needs CLI 26+
netlify init                           # link or create the site
netlify database init --yes            # or let the first deploy provision it
```

Migrations in `netlify/database/migrations/` are applied automatically on each deploy (preview branch first, production on publish). Don't run DDL against hosted databases yourself. For local development, run `netlify database migrations apply`.

Deploy preview-first: run `netlify deploy` to provision and migrate, check the draft URL, then run `netlify deploy --prod`.

### 2. Stripe Connect

1. In the Stripe Dashboard (test mode), enable **Connect** and complete the platform profile. Kitty uses **Standard** accounts with **direct charges**.
2. Add a webhook endpoint at `https://YOUR_SITE/webhooks/stripe`, set to **listen to events on Connected accounts**, with these events:
   `account.updated`, `account.application.deauthorized`, `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.succeeded`, `charge.refunded`, `checkout.session.expired`.
3. Copy its signing secret into `STRIPE_CONNECT_WEBHOOK_SECRET`.

Checkout Sessions use `capture_method: manual`. Card authorizations last about a week; the adapter reads the exact `capture_before` time from each charge, and the group deadline is set from it. Stripe requires a Checkout Session to stay open for at least 30 minutes, so return links are valid for 40.

### 3. Sign-in (Auth0)

1. Create an **API** in Auth0. Its identifier is your `AUTH_AUDIENCE`, for example `https://kitty-api`.
2. Create a **Single Page Application**. Add your production URL and your deploy-preview URL pattern to Allowed Callback URLs, Logout URLs and Web Origins.
3. Set `AUTH_JWKS_URL`, `AUTH_ISSUER` and `AUTH_AUDIENCE` in Netlify.
4. In `public/config.js`, set `mode: 'auth0'` and fill in `domain`, `clientId` and `audience`. These values are public.

### 4. Environment variables

Copy `.env.example` and set each value in **Site configuration → Environment variables**. Scope them by deploy context:

| Variable | Production | Deploy previews and local |
|---|---|---|
| `STRIPE_SECRET_KEY` | live key `sk_live_…` | test key `sk_test_…` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | live endpoint secret | test endpoint secret |
| `TOKEN_SIGNING_SECRET`, `ADDRESS_ENCRYPTION_KEY`, `INTERNAL_TASK_SECRET` | own random values (`openssl rand -base64 32`) | different random values |
| `DEV_AUTH` | unset | `true` (local only) |

Never reuse the address encryption key across environments. If you rotate it, existing addresses become unreadable unless you re-encrypt them first.

## Testing a deployed site without Auth0

For a test deploy you can skip Auth0 and use demo sign-in, where you type a name and act as that person:

1. Keep `mode: 'demo'` in `public/config.js` (the default).
2. Add the environment variable `DEMO_AUTH=true`.

The server refuses demo sign-in whenever a live Stripe key (`sk_live_…`) is set. Anyone can act as anyone in demo mode, so switch to Auth0 before real customers use the site.

## If the site loads but nothing works

Open `https://YOUR_SITE/api/health`. It lists what's missing without revealing any values, and the app shows the same checklist instead of the shop until everything passes.

| What you see | Cause | Fix |
|---|---|---|
| The `/api/health` URL shows Netlify's 404 page | Functions weren't deployed | Deploy from GitHub with `netlify.toml` and `package.json` at the top level of the repository. Drag-and-drop doesn't deploy functions. |
| "Kitty can't reach the database" or missing tables | Netlify Database isn't provisioned, or migrations didn't run | Check the deploy log for the database step and redeploy |
| "Environment variables not set: …" | Settings not added | Add them under Project configuration → Environment variables, then redeploy |
| "No sign-in is configured" or "demo sign-in … server doesn't allow it" | No Auth0 settings, and `DEMO_AUTH` not set | Set `DEMO_AUTH=true` for testing, or configure Auth0 |
| Everything passes but the shop is empty | Expected on a new site | Sign in, open your shop under For shops, connect Stripe (test mode), add an item |

Environment variable changes only take effect after a new deploy.

## Local development

```bash
netlify database migrations apply                         # local database
netlify dev                                               # http://localhost:8888
stripe listen --forward-connect-to localhost:8888/webhooks/stripe
```

`stripe listen` prints a webhook signing secret; put it in `STRIPE_CONNECT_WEBHOOK_SECRET` for local runs.

With `mode: 'dev'` in `public/config.js` and `DEV_AUTH=true`, the Sign in button lets you pick any name. Use a second browser profile to act as a second shopper. The server honors this only under `netlify dev`.

For a full run-through:

1. **Open a shop and connect Stripe.** Use Stripe's test onboarding values.
2. **Add an item and start a group.** Start a group as one shopper, then join it as another.
3. **Check out each cart.** Test card `4242 4242 4242 4242` approves and `4000 0000 0000 0002` declines.
4. **Dispatch from For shops.**

## Tests

```bash
npm test         # integration test: real SQL on PGlite (embedded Postgres), real services, fake Stripe client
npm run typecheck
```

The integration test covers:

- **Onboarding:** the account stays pending until verified, and shops can't take orders until then.
- **Group lifecycle:** forming and closing a group, and fixing even shares when it closes.
- **Checkout Router:** sessions are created on the vendor's account with manual capture and a 3% fee.
- **Return links:** signed, single-use and tied to the owning shopper.
- **Webhooks:** a duplicate event is stored only once.
- **Payment edge cases:** a decline followed by a retry, and an expired hold that is then re-authorized.
- **Group capture:** all carts captured together, ledger and fee totals checked, and the vendor sees decrypted addresses.
- **Fulfillment:** dispatch, completion, a single stock decrement, and reconciliation.
- **Failure paths:** a failed capture leads to refunds plus voids, an initiator cancel voids holds, and a late authorization on a cancelled group is released.
- **Nearby groups:** neighbors see a group with distance, spots and deadline but never coordinates; a shopper in another city can't see, open or join it; the same item nearby is flagged before a duplicate is created, and so is a similarly named product; the earlier initiator and opted-in neighbors are notified; fill-by closes a group with 2+ shoppers and cancels one with fewer.

## Before going live

- [ ] Run a full test-mode pass on a deploy preview, including a forced decline and a cancelled group.
- [ ] Confirm card-only (or other manual-capture-capable) payment methods in each vendor's Stripe settings.
- [ ] Decide the open product questions: per-shopper delivery fees, what happens to a non-paying cart, the refund policy for lost portions.
- [ ] Have counsel confirm the no-funds-held position and sales tax handling for your launch markets.
- [ ] Watch `webhook_event` rows with `result LIKE 'error%'` and `reconciliation_result` rows where `matched = false`.

## Not built yet

- **PayPal and Adyen adapters.** Implement `PaymentProvider` in `src/lib/providers/` and register it in `index.ts`. The core services need no changes.
- **Couriers.** The DoorDash Drive and Uber Direct adapters follow those providers' public API docs but haven't been run against their sandboxes. Verify request fields, especially Uber's address format, before enabling them. Without courier keys, dispatch falls back to manual: the shop books the courier and marks the portion delivered.
- **Email or push for notifications.** Notifications are in-app only; add a sender that reads unsent rows from `notification`.
- **Live updates.** The app polls every 8 seconds. Add a realtime channel if that feels slow.

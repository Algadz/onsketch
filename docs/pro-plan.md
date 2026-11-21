# OnSketch Pro (Stripe)

## What Pro gives

| | Free | Pro ($29/year) |
|---|---|---|
| Drawing tools | all | all |
| Export (PNG, SVG, copy, DXF, print / PDF to scale) | yes | yes |
| Sketches in the account | 3 | unlimited |
| Visibility | public (private sketches made under migration 0007 stay private) | private or public, per sketch |

Enforced in the database (`projects_check` trigger): the limit counts all
of a user's projects, and a free sketch can't become private (migration
0008; 0007 had allowed it for a while). The app no longer reads
`plan_rules()`: the free plan never offers Private, so the save form, My
sketches and the pricing page match what the server accepts once 0008 is
run. A free sketch made private under 0007 stays private, can be made
public, and keeps Private when its details are edited. On Pro, new
sketches start private (then the last choice on that device); a username
is asked for only when a sketch is made public.

Every export is free on every plan (DXF and to-scale printing were Pro
for a few hours on 2026-11-14, then opened to all).
`plan_of()` decides; the plan is stored in `account_plans`, which only the
service role writes. The database name of Pro is `premium`.

When Pro ends: nothing is deleted. Sketches stay readable and editable;
private ones stay private. A free account with 3 or more sketches can't
add another, and can't make a sketch private (it can make one public).

## How it works

```
Pricing page ──(signed in)──▶ billing function ──▶ Stripe API: POST /v1/checkout/sessions
   │                          (client_reference_id + subscription        │
   │                           metadata user_id, email or customer,      ▼
   │                           success → /pricing/?welcome=1)      Stripe Checkout, payment
   ▼                                                                       │
/pricing/?welcome=1 polls the plan  ◀── account_plans ◀── stripe-webhook ◀── customer.subscription.* events
                                         (service role)    (checks Stripe-Signature)
Manage subscription ──▶ billing function {action:'portal'} ──▶ Stripe customer-portal session
```

- `supabase/functions/billing/index.ts`: `checkout` (month / year price)
  and `portal`. Reuses the user's Stripe customer when they had one.
  Refuses a second subscription while one is active. Promotion codes are
  accepted at checkout. With `STRIPE_AUTOMATIC_TAX=1`, Stripe Tax adds
  sales tax / VAT and the billing address is asked for.
- `supabase/functions/stripe-webhook/index.ts`: verifies the
  `Stripe-Signature` (HMAC-SHA256, at most 5 minutes old), logs every event
  in `billing_events`, and upserts `account_plans` (plan, status, interval,
  renews_at, ends_at, subscription and customer ids). Pro while the Stripe
  status is `trialing`, `active` or `past_due`; a subscription set to cancel
  at the period end is saved as `cancelled` with `ends_at` and stays Pro
  until then (`plan_of()` in SQL enforces that date too). `canceled`,
  `unpaid`, `paused`, `incomplete` mean Free. A late event of an older
  subscription never ends a newer one. Events without an OnSketch user in
  the subscription's metadata are only logged.
- Database: no Stripe-specific migration. `0005_billing.sql` (columns,
  `billing_events`, `plan_of()`) works for both providers.
- App: `/pricing/` (yearly only, state for signed out, Free, Pro;
  waits for the webhook after paying), "Upgrade to Pro" or "Manage
  subscription" in the account menus, My sketches (usage bar, upgrade card,
  Make private / Make public), the save form's note, the landing page nav.

Tests: `tests/unit/billing.test.js` runs both functions under Node with
doubles for the database and the Stripe API (signature and its age,
status mapping, cancel at period end, out-of-order events, live only,
checkout and portal parameters, Stripe Tax). `tests/cloud.e2e.mjs` covers
the pricing page, checkout, the wait after paying, Manage subscription and
Pro in My sketches with a fake billing function.

Earlier, Pro was sold through Lemon Squeezy (a merchant of record: it was
the seller and handled sales tax / VAT). With Stripe, **OnSketch is the
seller**: Stripe processes the payments, but registering for and paying
sales tax / VAT is the owner's job (Stripe Tax can calculate and collect it).

## Setup (once, by the owner)

Values to collect on the way: the yearly price id, an API key, the webhook
signing secret. They go into Supabase secrets only, never in code.

1. **Supabase SQL Editor**: run `supabase/migrations/0005_billing.sql`
   (if not done yet), then `supabase/migrations/0008_private_pro_only.sql`.
2. **A sandbox to build in**: Stripe recommends a sandbox (an isolated test
   environment) over the shared test mode: account menu (top left) →
   **Sandboxes → Create sandbox** (e.g. "onsketch-dev"), then switch to it.
   Steps 3–7 happen in the sandbox; no real money moves there. (The shared
   *Test mode* works the same way if you prefer it.)
3. **Product and price** (Product catalog → + Add product): name
   `OnSketch Pro`, **Recurring**, **$29**, **Yearly**. If you'll collect tax
   (step 11), pick the product's **tax code** now (Software as a service)
   and the price's **tax behaviour** (exclusive: tax added on top;
   inclusive: $29 includes it). Open the price and copy its id `price_…`.
   (Already made the live $29 price? Do the same in the sandbox: sandbox
   and live don't share products.)
4. **Customer portal** (Settings → Billing → Customer portal): allow
   updating payment methods, invoice history, and cancelling **at the end
   of the billing period**. Plan switching isn't needed (one price). Save.
5. **Restricted API key** (Developers → API keys → **Create restricted
   key**), name "onsketch-supabase", with:
   - Checkout Sessions: **Write**
   - Customer portal: **Write**
   - Customers: **Write**
   - Prices and Products: **Read**
   - Subscriptions: **Read**
   Copy it (`rk_test_…`). If a checkout later fails with a permission
   error, the message names the missing permission: add it to the key.
6. **Webhook** (Developers → Webhooks → **Add destination** → Webhook
   endpoint):
   - API version: **2026-10-28.endive** (the version the functions pin)
   - URL `https://rwmzpzaqijgdfsjmpqbd.supabase.co/functions/v1/stripe-webhook`
   - Events: `customer.subscription.created`, `.updated`, `.deleted`,
     `.paused`, `.resumed` (these set the plan), and `invoice.paid`,
     `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`,
     `radar.early_fraud_warning.created` (logged in `billing_events` with
     the user, for support).
   - Then reveal the destination's **Signing secret** (`whsec_…`).
7. **Supabase → Edge Functions → Secrets** (or `npx supabase secrets set …`):
   - `STRIPE_SECRET_KEY`: the restricted key (step 5)
   - `STRIPE_PRICE_YEARLY`: the `price_…` (step 3)
   - `STRIPE_WEBHOOK_SECRET`: the signing secret (step 6)
   Delete the old `LEMONSQUEEZY_*` secrets (and `STRIPE_PRICE_MONTHLY` if
   set: Pro is yearly only).
8. **Deploy the two functions**, either:
   - dashboard: Edge Functions → **billing** → Code → replace with
     `supabase/functions/billing/index.ts` → Deploy (*Verify JWT* **on**);
     **Deploy a new function → Via Editor**, name `stripe-webhook`, paste
     `supabase/functions/stripe-webhook/index.ts` → Deploy, then *Verify
     JWT* **off** (Stripe sends a signature, not a Supabase token); delete
     `lemonsqueezy-webhook`.
   - or CLI, from a checkout of the repo (`supabase/config.toml` sets the
     JWT switches): `npx supabase login`, `npx supabase link --project-ref
     rwmzpzaqijgdfsjmpqbd`, `npx supabase functions deploy billing`,
     `npx supabase functions deploy stripe-webhook`,
     `npx supabase functions delete lemonsqueezy-webhook`.
9. **Test** on onsketch.io/pricing (signed in, not Pro): **Get Pro**, pay
   with `4242 4242 4242 4242`, any future date, any CVC. The page should say
   "OnSketch Pro is on"; `account_plans` has your row with `plan` premium
   and `customer_id` `cus_…`; **Manage subscription** opens the portal;
   cancel there and the page says "Ends on …". If Pro never comes on, look
   at the webhook destination's deliveries in Stripe: 401 = wrong signing
   secret or *Verify JWT* still on; 404 = function name; 500 = the
   function's Logs in Supabase.
10. **Going live** (account activated): in live mode, redo steps 3–7
    (live product/price, portal settings, a live restricted key `rk_live_…`,
    a live webhook destination with its own signing secret) and replace the
    secrets. Add `STRIPE_LIVE_ONLY` = `1`, and end the test subscriptions:
    `update account_plans set plan = 'free' where test_mode;`
    Then go through Stripe's go-live checklist
    (docs.stripe.com/get-started/checklist/go-live).
11. **Tax**: OnSketch is the seller. Stripe Tax collects nothing until you
    have an active **registration** where your customers are, even with it
    switched on (and gives no error). So: Settings → Tax → origin address,
    check where you must register (Stripe's threshold monitoring helps),
    register with the tax authority, add the registrations in Stripe, then
    add the Supabase secret `STRIPE_AUTOMATIC_TAX` = `1` (the checkout then
    asks for the billing address and adds tax). See
    docs.stripe.com/billing/taxes/collect-taxes.

Subscribers from the Lemon Squeezy days keep their row: Pro until their
subscription's `ends_at` (or as it is), and Manage subscription opens their
saved Lemon Squeezy link. To move one to Stripe, they cancel there and
subscribe again on the pricing page.

## Later

- Prices shown on the page are fixed in `app/src/pricing/page.js`; read
  them from the Stripe API if they change often.
- Discount codes: Stripe → Product catalog → Coupons → promotion codes
  (the checkout already accepts them).
- Free trial: `subscription_data[trial_period_days]` in the checkout.
- Team / education plans.
- An admin page for support (billing_events, a user's plan).

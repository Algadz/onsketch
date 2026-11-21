# OnSketch Pro (Stripe)

## What Pro gives

| | Free | Pro ($9.99/month or $89/year) |
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
- App: `/pricing/` (monthly / yearly, state for signed out, Free, Pro;
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

1. **Supabase SQL Editor**: run `supabase/migrations/0005_billing.sql`
   (if not done yet), then `supabase/migrations/0008_private_pro_only.sql`.
2. **Stripe account**: sign up at stripe.com. Everything below can be done
   in **test mode** first (the "Test mode" switch, top right) before the
   account is activated.
3. **Product and prices** (Product catalog → + Add product):
   - Name `OnSketch Pro`.
   - Price 1: **Recurring**, $9.99, **Monthly**.
   - Price 2 (Add another price): **Recurring**, $89, **Yearly**.
   - Open each price and copy its id (`price_…`).
4. **Customer portal** (Settings → Billing → Customer portal): turn on
   *Customers can update payment methods*, *view invoice history*,
   *cancel subscriptions* (at the end of the billing period), and under
   *Subscriptions → Customers can switch plans* add both OnSketch Pro
   prices (the pricing page FAQ says monthly ↔ yearly is switched there).
   Save. (In test mode this is a separate setting: save it in both modes.)
5. **API key** (Developers → API keys): copy the **Secret key** (`sk_test_…`
   in test mode). A restricted key also works: Checkout Sessions *write*,
   Customer portal *write*, Customers *read*, Subscriptions *read*.
6. **Webhook** (Developers → Webhooks → + Add endpoint):
   - URL `https://rwmzpzaqijgdfsjmpqbd.supabase.co/functions/v1/stripe-webhook`
   - Events: `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `customer.subscription.paused`, `customer.subscription.resumed`
     (optionally `checkout.session.completed` and `invoice.payment_failed`:
     they are only logged).
   - After saving, reveal the endpoint's **Signing secret** (`whsec_…`).
7. **Supabase → Edge Functions → Secrets**, add:
   - `STRIPE_SECRET_KEY`: the secret key (step 5)
   - `STRIPE_PRICE_MONTHLY`: the monthly `price_…` (step 3)
   - `STRIPE_PRICE_YEARLY`: the yearly `price_…` (step 3)
   - `STRIPE_WEBHOOK_SECRET`: the signing secret (step 6)
   You can delete the old `LEMONSQUEEZY_*` secrets.
8. **Deploy the two functions** (Supabase → Edge Functions; with the CLI:
   `supabase functions deploy billing` and
   `supabase functions deploy stripe-webhook`):
   - `billing`: replace its code with `supabase/functions/billing/index.ts`;
     *Verify JWT* **on**.
   - `stripe-webhook` (new function): paste
     `supabase/functions/stripe-webhook/index.ts`; *Verify JWT* **off**.
   - Delete the old `lemonsqueezy-webhook` function.
9. **Test**: on onsketch.io/pricing, buy Pro with the test card
   `4242 4242 4242 4242` (any future date, any CVC). Check that the page
   says "OnSketch Pro is on", that `account_plans` has the row
   (`customer_id` `cus_…`) and `billing_events` the events; open Manage
   subscription, switch to yearly, then cancel and check that the page
   says "Ends on …". Stripe → Developers → Webhooks shows each delivery
   and its response if something doesn't arrive.
10. **Going live** (account activated): switch the dashboard to live mode
    and repeat steps 3 to 7 there (live products, prices, portal settings,
    secret key `sk_live_…`, webhook and its new signing secret): live and
    test mode don't share any of them. Add the secret `STRIPE_LIVE_ONLY` =
    `1` so leftover test events can't give Pro, and end the test
    subscriptions: `update account_plans set plan = 'free' where test_mode;`
11. **Tax** (your decision, see above): to have Stripe add sales tax / VAT,
    set up Stripe Tax (Settings → Tax: origin address, registrations) and
    add the secret `STRIPE_AUTOMATIC_TAX` = `1`. The prices on the pricing
    page are then before tax where tax applies.

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

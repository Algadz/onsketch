# OnSketch Pro (Lemon Squeezy)

## What Pro gives

| | Free | Pro ($9.99/month or $89/year) |
|---|---|---|
| Drawing tools | all | all |
| Sketches in the account | 3 | unlimited |
| Visibility | public (library) | private or public, per sketch |

Enforced in the database (`projects_check` trigger, migration 0002): the
limit counts all of a user's projects; making a sketch private needs Pro.
`plan_of()` decides; the plan is stored in `account_plans`, which only the
service role writes. The database name of Pro is `premium`.

When Pro ends: nothing is deleted. Sketches stay readable and editable;
private ones stay private. A free account with 3 or more sketches can't
add another, and can't make a sketch private (it can make one public).

## How it works

```
Pricing page ──(signed in)──▶ billing function ──▶ Lemon Squeezy API: POST /v1/checkouts
   │                          (custom data: user_id, email,                │
   │                           redirect /pricing/?welcome=1)              ▼
   │                                                           hosted checkout, payment
   ▼                                                                       │
/pricing/?welcome=1 polls the plan  ◀── account_plans ◀── lemonsqueezy-webhook ◀── subscription_* events
                                         (service role)    (checks X-Signature)
Manage subscription ──▶ billing function {action:'portal'} ──▶ fresh customer-portal URL
```

- `supabase/functions/billing/index.ts`: `checkout` (month / year) and
  `portal`. The product ids 1511078 (monthly) and 1511073 (yearly) may be
  product or variant ids: a product id is resolved to its published
  variant. Refuses a second subscription while one is active.
- `supabase/functions/lemonsqueezy-webhook/index.ts`: verifies the
  HMAC-SHA256 signature, logs every event in `billing_events`, and upserts
  `account_plans` (plan, status, interval, renews_at, ends_at,
  subscription and customer ids, portal URL). Pro while the status is
  `on_trial`, `active`, `past_due`, or `cancelled` until `ends_at`;
  `paused`, `unpaid`, `expired` mean Free. Events without an OnSketch user
  in the custom data are only logged.
- `supabase/migrations/0005_billing.sql`: the new columns, `billing_events`,
  and `plan_of()` ending Pro by itself after a cancelled subscription's end
  date (if the `subscription_expired` event is late or lost).
- App: `/pricing/` (monthly / yearly, state for signed out, Free, Pro;
  waits for the webhook after paying), "Upgrade to Pro" or "Manage
  subscription" in the account menus, My sketches (usage bar, upgrade card,
  Make private / Make public), the save form's note, the landing page nav.

Tests: `tests/unit/billing.test.js` runs both functions under Node with
doubles for the database and the Lemon Squeezy API (signature, mapping,
checkout payload, product → variant, portal). `tests/cloud.e2e.mjs` covers
the pricing page, checkout, the wait after paying, Manage subscription and
Pro in My sketches with a fake billing function. The migration was run on
a local PostgreSQL.

## Setup (once, by the owner)

1. **Supabase SQL Editor**: run `supabase/migrations/0005_billing.sql`.
2. **Lemon Squeezy → Settings → API**: create an API key. Note the store id
   (Settings → Stores, the number).
3. **Supabase → Edge Functions → Secrets**, add:
   - `LEMONSQUEEZY_API_KEY`: the API key
   - `LEMONSQUEEZY_STORE_ID`: the store id
   - `LEMONSQUEEZY_SIGNING_SECRET`: a long random string (also used in step 5)
4. **Deploy the two functions** (Supabase → Edge Functions → Deploy a new
   function → Via editor, or `supabase functions deploy` with the CLI):
   - `billing`: paste `supabase/functions/billing/index.ts`; *Verify JWT*
     **on**.
   - `lemonsqueezy-webhook`: paste
     `supabase/functions/lemonsqueezy-webhook/index.ts`; *Verify JWT* **off**.
5. **Lemon Squeezy → Settings → Webhooks → +**:
   - URL `https://rwmzpzaqijgdfsjmpqbd.supabase.co/functions/v1/lemonsqueezy-webhook`
   - Signing secret: the same string as `LEMONSQUEEZY_SIGNING_SECRET`
   - Events: `subscription_created`, `subscription_updated`,
     `subscription_cancelled`, `subscription_resumed`,
     `subscription_expired`, `subscription_paused`,
     `subscription_unpaused`, `subscription_payment_success`,
     `subscription_payment_failed`, `subscription_payment_recovered`.
6. **Test mode first**: with Lemon Squeezy in test mode, buy Pro on
   onsketch.io/pricing with the test card 4242 4242 4242 4242; check that
   the page says "OnSketch Pro is on", that `account_plans` has the row and
   `billing_events` the events; cancel from Manage subscription. Then
   switch the store and the API key to live.

## Later

- Prices shown on the page are fixed in `app/src/pricing/page.js`; read
  them from the Lemon Squeezy API if they change often.
- Plan switch monthly ↔ yearly from the app (Lemon Squeezy API
  `PATCH /v1/subscriptions/:id` with the other variant).
- Discount codes (Lemon Squeezy discounts work at checkout as is).
- Team / education plans.
- An admin page for support (billing_events, a user's plan).

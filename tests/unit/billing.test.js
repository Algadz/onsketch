// Stripe webhook and billing Edge Functions, run under Node with test
// doubles for the database and the Stripe API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook, hmacHex, planRow, verifySignature } from '../../supabase/functions/stripe-webhook/index.ts';
import { formEncode, handleBilling } from '../../supabase/functions/billing/index.ts';

const SECRET = 'whsec_test';
const USER = '6b93c7ee-02cc-4c5b-b6bd-e20d70ae4695';
const NOW = Date.UTC(2026, 10, 21, 12) ;
const T = Math.floor(NOW / 1000);
const DAY = 86400;

function fakeAdmin() {
  const tables = { billing_events: [], account_plans: [] };
  return {
    tables,
    from: (t) => ({
      insert: async (row) => { tables[t].push(row); return { error: null }; },
      upsert: async (row) => {
        const i = tables[t].findIndex(r => r.user_id === row.user_id);
        if (i >= 0) tables[t][i] = row; else tables[t].push(row);
        return { error: null };
      },
      select: () => ({ eq: (k, v) => ({ maybeSingle: async () => ({ data: tables[t].find(r => r[k] === v) || null }) }) }),
    }),
  };
}
const sub = (over = {}) => ({
  id: 'sub_1', object: 'subscription', status: 'active', customer: 'cus_9', metadata: { user_id: USER },
  cancel_at_period_end: false, cancel_at: null,
  items: { data: [{ current_period_end: T + 365 * DAY, price: { id: 'price_y', recurring: { interval: 'year' } } }] },
  ...over,
});
const event = (type, object, { live = false } = {}) => ({ id: 'evt_1', type, livemode: live, data: { object } });
async function send(body, { sign = true, secret = SECRET, t = T } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['Stripe-Signature'] = `t=${t},v1=${await hmacHex(secret, `${t}.${raw}`)}`;
  return new Request('https://fn/stripe-webhook', { method: 'POST', headers, body: raw });
}
const hook = async (body, admin, opts = {}) => handleWebhook(await send(body, opts), { secret: SECRET, admin, now: NOW, ...opts.hook });

test('webhook: a bad, missing or stale signature is refused and nothing is written', async () => {
  const admin = fakeAdmin();
  const body = event('customer.subscription.created', sub());
  assert.equal((await hook(body, admin, { sign: false })).status, 401);
  assert.equal((await hook(body, admin, { secret: 'other' })).status, 401);
  assert.equal((await hook(body, admin, { t: T - 600 })).status, 401, 'older than 5 minutes');
  assert.equal(admin.tables.billing_events.length + admin.tables.account_plans.length, 0);
  assert.ok(await verifySignature(`t=${T},v1=bad,v1=${await hmacHex(SECRET, `${T}.x`)}`, 'x', SECRET, NOW), 'any of several v1 signatures');
});

test('webhook: a new subscription gives Pro, yearly, with its renewal date and customer', async () => {
  const admin = fakeAdmin();
  const res = await hook(event('customer.subscription.created', sub()), admin);
  assert.equal(res.status, 200);
  const row = admin.tables.account_plans[0];
  assert.equal(row.user_id, USER);
  assert.equal(row.plan, 'premium');
  assert.equal(row.status, 'active');
  assert.equal(row.interval, 'year');
  assert.equal(row.renews_at, new Date((T + 365 * DAY) * 1000).toISOString());
  assert.equal(row.ends_at, null);
  assert.equal(row.customer_id, 'cus_9');
  assert.equal(row.subscription_id, 'sub_1');
  assert.equal(row.test_mode, true);
  assert.equal(admin.tables.billing_events[0].event_name, 'customer.subscription.created');
});

test('webhook: cancelled at the period end stays Pro until then; deleted is Free', async () => {
  const admin = fakeAdmin();
  await hook(event('customer.subscription.updated', sub({ cancel_at_period_end: true })), admin);
  let row = admin.tables.account_plans[0];
  assert.equal(row.plan, 'premium');
  assert.equal(row.status, 'cancelled');
  assert.equal(row.ends_at, new Date((T + 365 * DAY) * 1000).toISOString());
  assert.equal(row.renews_at, null);
  await hook(event('customer.subscription.deleted', sub({ status: 'canceled', ended_at: T })), admin);
  row = admin.tables.account_plans[0];
  assert.equal(row.plan, 'free');
  assert.equal(row.status, 'canceled');
});

test('webhook: past due keeps Pro; unpaid, paused and incomplete are Free', () => {
  assert.equal(planRow(USER, sub({ status: 'past_due' }), false).plan, 'premium');
  for (const s of ['unpaid', 'paused', 'incomplete', 'incomplete_expired']) assert.equal(planRow(USER, sub({ status: s }), false).plan, 'free', s);
  assert.equal(planRow(USER, sub({ current_period_end: T + 30 * DAY, items: { data: [{ price: { recurring: { interval: 'month' } } }] } }), false).interval, 'month',
    'older API versions: the period end on the subscription');
});

test('webhook: no OnSketch user, or another event type, is only logged', async () => {
  const admin = fakeAdmin();
  assert.equal((await hook(event('customer.subscription.created', sub({ metadata: {} })), admin)).status, 200);
  assert.equal((await hook(event('invoice.paid', { object: 'invoice', subscription: 'sub_1' }), admin)).status, 200);
  assert.equal(admin.tables.account_plans.length, 0);
  assert.equal(admin.tables.billing_events.length, 2);
  assert.equal(admin.tables.billing_events[1].subscription_id, 'sub_1');
});

test('webhook: once live only, test-mode events are logged but change no plan', async () => {
  const admin = fakeAdmin();
  await hook(event('customer.subscription.created', sub()), admin, { hook: { liveOnly: true } });
  assert.equal(admin.tables.account_plans.length, 0);
  assert.equal(admin.tables.billing_events.length, 1);
  await hook(event('customer.subscription.created', sub(), { live: true }), admin, { hook: { liveOnly: true } });
  assert.equal(admin.tables.account_plans[0].plan, 'premium');
  assert.equal(admin.tables.account_plans[0].test_mode, false);
});

test('webhook: a late "deleted" of an older subscription doesn\'t end a newer one', async () => {
  const admin = fakeAdmin();
  await hook(event('customer.subscription.created', sub({ id: 'sub_new' })), admin);
  await hook(event('customer.subscription.deleted', sub({ id: 'sub_old', status: 'canceled' })), admin);
  assert.equal(admin.tables.account_plans[0].plan, 'premium');
  assert.equal(admin.tables.account_plans[0].subscription_id, 'sub_new');
});

/* ---- billing function ---- */
function deps({ user = { id: USER, email: 'a@b.c' }, plan = null, fail = null } = {}) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init, params: new URLSearchParams(init.body) });
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (fail) return reply(fail, { error: { message: 'Invalid API Key provided' } });
    if (url.endsWith('/checkout/sessions')) return reply(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (url.endsWith('/billing_portal/sessions')) return reply(200, { url: 'https://billing.stripe.com/p/session/x' });
    return reply(404, { error: { message: 'no' } });
  };
  return { calls, d: { env: { secretKey: 'sk_test_x', prices: { month: 'price_m', year: 'price_y' }, automaticTax: false, site: 'https://onsketch.io' },
    fetch: fakeFetch, getUser: async () => user, getPlanRow: async () => plan } };
}
const call = (body) => new Request('https://fn/billing', { method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer t' } });

test('billing: Stripe form encoding, nested keys included', () => {
  assert.equal(formEncode({ a: 1, b: { c: 'x y', d: { 0: 2 } }, e: undefined }), 'a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B0%5D=2');
});

test('billing: checkout carries the user id, email, price and return pages', async () => {
  const { d, calls } = deps();
  const res = await handleBilling(call({ action: 'checkout', interval: 'year' }), d);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_1');
  const p = calls[0].params;
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_x');
  assert.equal(p.get('mode'), 'subscription');
  assert.equal(p.get('line_items[0][price]'), 'price_y');
  assert.equal(p.get('client_reference_id'), USER);
  assert.equal(p.get('subscription_data[metadata][user_id]'), USER);
  assert.equal(p.get('customer_email'), 'a@b.c');
  assert.equal(p.get('success_url'), 'https://onsketch.io/pricing/?welcome=1');
  assert.equal(p.get('automatic_tax[enabled]'), null);
});

test('billing: a returning customer is reused; Stripe Tax when switched on', async () => {
  const { d, calls } = deps({ plan: { plan: 'free', status: 'canceled', customer_id: 'cus_9' } });
  d.env.automaticTax = true;
  await handleBilling(call({ action: 'checkout', interval: 'month' }), d);
  const p = calls[0].params;
  assert.equal(p.get('customer'), 'cus_9');
  assert.equal(p.get('customer_email'), null);
  assert.equal(p.get('line_items[0][price]'), 'price_m');
  assert.equal(p.get('automatic_tax[enabled]'), 'true');
  assert.equal(p.get('customer_update[address]'), 'auto');
});

test('billing: signed out 401, already Pro 409, portal for the customer', async () => {
  assert.equal((await handleBilling(call({ action: 'checkout' }), deps({ user: null }).d)).status, 401);
  assert.equal((await handleBilling(call({ action: 'checkout' }), deps({ plan: { plan: 'premium', status: 'active' } }).d)).status, 409);
  const { d, calls } = deps({ plan: { plan: 'premium', status: 'active', subscription_id: 'sub_1', customer_id: 'cus_9' } });
  const res = await handleBilling(call({ action: 'portal' }), d);
  assert.equal((await res.json()).url, 'https://billing.stripe.com/p/session/x');
  assert.equal(calls[0].params.get('customer'), 'cus_9');
  assert.equal(calls[0].params.get('return_url'), 'https://onsketch.io/pricing/');
  assert.equal((await handleBilling(call({ action: 'portal' }), deps().d)).status, 404);
  const old = await handleBilling(call({ action: 'portal' }), deps({ plan: { plan: 'premium', subscription_id: '987', customer_id: '42', portal_url: 'https://old-portal' } }).d);
  assert.equal((await old.json()).url, 'https://old-portal', 'a subscription from before Stripe: its saved link');
});

test('billing: says what Stripe refused; not configured is a 500', async () => {
  const res = await handleBilling(call({ action: 'checkout', interval: 'month' }), deps({ fail: 401 }).d);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Invalid API Key/);
  const none = deps();
  none.d.env.prices.year = '';
  assert.equal((await handleBilling(call({ action: 'checkout', interval: 'year' }), none.d)).status, 500);
});

test('billing: pinned API version and integration tag; yearly when no monthly price', async () => {
  const { d, calls } = deps();
  d.env.prices.month = '';
  await handleBilling(call({ action: 'checkout', interval: 'month' }), d);
  assert.equal(calls[0].init.headers['Stripe-Version'], '2026-10-28.endive');
  assert.equal(calls[0].params.get('line_items[0][price]'), 'price_y', 'yearly only: a monthly request gets the yearly price');
  assert.match(calls[0].params.get('integration_identifier'), /^onsketch_pro_checkout_[a-z]{8}$/);
});

test('webhook: the user is found by the saved Stripe customer, metadata is the fallback', async () => {
  const admin = fakeAdmin();
  const OTHER = '11111111-2222-4333-8444-555555555555';
  admin.tables.account_plans.push({ user_id: OTHER, plan: 'free', customer_id: 'cus_9', subscription_id: 'sub_0' });
  await hook(event('customer.subscription.created', sub({ metadata: {} })), admin);
  assert.equal(admin.tables.account_plans.length, 1);
  assert.equal(admin.tables.account_plans[0].user_id, OTHER);
  assert.equal(admin.tables.account_plans[0].plan, 'premium');
  await hook(event('customer.subscription.created', sub({ customer: 'cus_new' })), admin);
  assert.ok(admin.tables.account_plans.some(r => r.user_id === USER && r.customer_id === 'cus_new'), 'a first subscription: from the metadata');
});

test('webhook: refunds, disputes and fraud warnings are logged with the customer\'s user', async () => {
  const admin = fakeAdmin();
  admin.tables.account_plans.push({ user_id: USER, plan: 'premium', customer_id: 'cus_9', subscription_id: 'sub_1' });
  for (const t of ['charge.refunded', 'charge.dispute.created', 'radar.early_fraud_warning.created']) {
    assert.equal((await hook(event(t, { object: t.startsWith('radar') ? 'radar.early_fraud_warning' : 'charge', customer: 'cus_9' }), admin)).status, 200);
  }
  assert.deepEqual(admin.tables.billing_events.map(e => e.user_id), [USER, USER, USER]);
  assert.equal(admin.tables.account_plans[0].plan, 'premium', 'no automatic change: the owner decides in Stripe');
});

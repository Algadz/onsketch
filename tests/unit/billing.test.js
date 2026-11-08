// Lemon Squeezy webhook and billing Edge Functions, run under Node with
// test doubles for the database and the Lemon Squeezy API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook, hmacHex, planRow } from '../../supabase/functions/lemonsqueezy-webhook/index.ts';
import { handleBilling } from '../../supabase/functions/billing/index.ts';

const SECRET = 'whsec_test';
const USER = '6b93c7ee-02cc-4c5b-b6bd-e20d70ae4695';

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
    }),
  };
}
const event = (name, attrs, { user = USER, test = true } = {}) => ({
  meta: { event_name: name, test_mode: test, custom_data: user ? { user_id: user } : undefined },
  data: { type: 'subscriptions', id: '987', attributes: { status: 'active', variant_id: 1511125, product_id: 55, customer_id: 42,
    renews_at: '2027-11-08T00:00:00Z', ends_at: null, urls: { customer_portal: 'https://x.lemonsqueezy.com/billing?sig=1' }, ...attrs } },
});
async function send(body, { sign = true, secret = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['X-Signature'] = await hmacHex(secret, raw);
  return new Request('https://fn/lemonsqueezy-webhook', { method: 'POST', headers, body: raw });
}

test('webhook: a bad or missing signature is refused and nothing is written', async () => {
  const admin = fakeAdmin();
  assert.equal((await handleWebhook(await send(event('subscription_created', {}), { sign: false }), { secret: SECRET, admin })).status, 401);
  assert.equal((await handleWebhook(await send(event('subscription_created', {}), { secret: 'other' }), { secret: SECRET, admin })).status, 401);
  assert.equal(admin.tables.account_plans.length + admin.tables.billing_events.length, 0);
});

test('webhook: subscription created → Pro, yearly, with portal and renewal date', async () => {
  const admin = fakeAdmin();
  const res = await handleWebhook(await send(event('subscription_created', {})), { secret: SECRET, admin });
  assert.equal(res.status, 200);
  const row = admin.tables.account_plans[0];
  assert.equal(row.user_id, USER);
  assert.equal(row.plan, 'premium');
  assert.equal(row.interval, 'year');
  assert.equal(row.subscription_id, '987');
  assert.equal(row.portal_url, 'https://x.lemonsqueezy.com/billing?sig=1');
  assert.equal(admin.tables.billing_events.length, 1);
});

test('webhook: cancelled keeps Pro until the end date; expired and paused end it', () => {
  const future = new Date(Date.now() + 86400e3).toISOString(), past = new Date(Date.now() - 86400e3).toISOString();
  assert.equal(planRow(USER, event('x', { status: 'cancelled', ends_at: future }).data, false).plan, 'premium');
  assert.equal(planRow(USER, event('x', { status: 'cancelled', ends_at: past }).data, false).plan, 'free');
  assert.equal(planRow(USER, event('x', { status: 'expired' }).data, false).plan, 'free');
  assert.equal(planRow(USER, event('x', { status: 'paused' }).data, false).plan, 'free');
  assert.equal(planRow(USER, event('x', { status: 'past_due' }).data, false).plan, 'premium');
  assert.equal(planRow(USER, event('x', { variant_id: 1511119 }).data, false).interval, 'month');
});

test('webhook: events without an OnSketch user, or not about subscriptions, are only logged', async () => {
  const admin = fakeAdmin();
  assert.equal((await handleWebhook(await send(event('subscription_created', {}, { user: null })), { secret: SECRET, admin })).status, 200);
  assert.equal((await handleWebhook(await send({ meta: { event_name: 'order_created', custom_data: { user_id: USER } }, data: { type: 'orders', id: '1' } }), { secret: SECRET, admin })).status, 200);
  assert.equal(admin.tables.account_plans.length, 0);
  assert.equal(admin.tables.billing_events.length, 2);
});

/* ---- billing function ---- */
function deps({ user = { id: USER, email: 'a@b.c' }, plan = null, variants = { '1511125': true }, products = {} } = {}) {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const path = url.replace('https://api.lemonsqueezy.com/v1', '');
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    let m;
    if ((m = /^\/variants\/(\d+)$/.exec(path))) return variants[m[1]] ? reply(200, { data: { id: m[1] } }) : reply(404, { errors: [{ detail: 'Not found' }] });
    if ((m = /^\/variants\?filter\[product_id\]=(\d+)$/.exec(path))) return reply(200, { data: (products[m[1]] || []).map(id => ({ id, attributes: { status: 'published' } })) });
    if (path === '/checkouts') return reply(201, { data: { attributes: { url: 'https://onsketch.lemonsqueezy.com/checkout/custom/abc' } } });
    if ((m = /^\/subscriptions\/(\w+)$/.exec(path))) return reply(200, { data: { attributes: { urls: { customer_portal: 'https://fresh-portal' } } } });
    return reply(404, {});
  };
  return { calls, d: { env: { apiKey: 'k', storeId: '777', ids: { month: '1511119', year: '1511125' }, site: 'https://onsketch.io' },
    fetch: fakeFetch, getUser: async () => user, getPlanRow: async () => plan } };
}
const call = (body) => new Request('https://fn/billing', { method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer t' } });

test('billing: checkout carries the user id, email, store, variant and return page', async () => {
  const { d, calls } = deps();
  const res = await handleBilling(call({ action: 'checkout', interval: 'year' }), d);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://onsketch.lemonsqueezy.com/checkout/custom/abc');
  const sent = JSON.parse(calls.find(c => c.url.endsWith('/checkouts')).init.body).data;
  assert.equal(sent.attributes.checkout_data.custom.user_id, USER);
  assert.equal(sent.attributes.checkout_data.email, 'a@b.c');
  assert.equal(sent.attributes.product_options.redirect_url, 'https://onsketch.io/pricing/?welcome=1');
  assert.equal(sent.relationships.store.data.id, '777');
  assert.equal(sent.relationships.variant.data.id, '1511125');
});

test('billing: a product id is resolved to its variant', async () => {
  const { d, calls } = deps({ variants: {}, products: { '1511119': ['222333'] } });
  const res = await handleBilling(call({ action: 'checkout', interval: 'month' }), d);
  assert.equal(res.status, 200);
  const sent = JSON.parse(calls.find(c => c.url.endsWith('/checkouts')).init.body).data;
  assert.equal(sent.relationships.variant.data.id, '222333');
});

test('billing: signed out 401, already Pro 409, portal returns a fresh link', async () => {
  assert.equal((await handleBilling(call({ action: 'checkout' }), deps({ user: null }).d)).status, 401);
  assert.equal((await handleBilling(call({ action: 'checkout' }), deps({ plan: { plan: 'premium', status: 'active' } }).d)).status, 409);
  const res = await handleBilling(call({ action: 'portal' }), deps({ plan: { plan: 'premium', subscription_id: '987', portal_url: 'https://old' } }).d);
  assert.equal((await res.json()).url, 'https://fresh-portal');
  assert.equal((await handleBilling(call({ action: 'portal' }), deps().d)).status, 404);
});

test('webhook: once live only, test-mode events are logged but change no plan', async () => {
  const admin = fakeAdmin();
  const res = await handleWebhook(await send(event('subscription_created', {}, { test: true })), { secret: SECRET, admin, liveOnly: true });
  assert.equal(res.status, 200);
  assert.equal(admin.tables.account_plans.length, 0);
  assert.equal(admin.tables.billing_events.length, 1);
  await handleWebhook(await send(event('subscription_created', {}, { test: false })), { secret: SECRET, admin, liveOnly: true });
  assert.equal(admin.tables.account_plans[0].plan, 'premium');
});

test('billing: says why a plan is unavailable (bad key, or an id the key cannot see)', async () => {
  const unknown = deps({ variants: {}, products: {} });
  const res = await handleBilling(call({ action: 'checkout', interval: 'month' }), unknown.d);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no product or variant 1511119.*test-mode/);
  const badKey = deps();
  badKey.d.fetch = async () => new Response(JSON.stringify({ errors: [{ status: '401' }] }), { status: 401 });
  assert.match((await (await handleBilling(call({ action: 'checkout', interval: 'year' }), badKey.d)).json()).error, /refused the API key/);
});

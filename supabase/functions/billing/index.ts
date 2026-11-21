// Supabase Edge Function: billing (Stripe)
//
// Called by the signed-in app (Verify JWT ON, the default):
//   POST { action: 'checkout', interval: 'month' | 'year' }  → { url }
//     A Stripe Checkout session for OnSketch Pro (a subscription), with the
//     user's id as client_reference_id and in the subscription's metadata
//     (the stripe-webhook function reads it back), their email pre-filled
//     (or their Stripe customer reused), and a return to
//     https://onsketch.io/pricing/?welcome=1 after paying.
//   POST { action: 'portal' }  → { url }
//     A fresh Stripe customer-portal session (change card, switch monthly /
//     yearly, cancel, invoices).
//
// Secrets (Edge Functions → Secrets):
//   STRIPE_SECRET_KEY     sk_test_… or sk_live_… (Developers → API keys)
//   STRIPE_PRICE_MONTHLY  price_… of the monthly Pro price
//   STRIPE_PRICE_YEARLY   price_… of the yearly Pro price
// Optional:
//   STRIPE_AUTOMATIC_TAX  "1" to have Stripe Tax add sales tax / VAT at
//                         checkout (Stripe Tax must be set up first)
//   SITE_URL              default https://onsketch.io
// No imports at the top: tests run handleBilling() under Node.

const API = 'https://api.stripe.com/v1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Env = { secretKey: string; prices: { month: string; year: string }; automaticTax: boolean; site: string };
type Deps = { env: Env; getUser: (req: Request) => Promise<any>; getPlanRow: (userId: string) => Promise<any>; fetch: typeof fetch };

/** Stripe's form encoding, nested keys included: { a: { b: 1 } } → a[b]=1. */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') out.push(formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

async function stripe(deps: Deps, path: string, params: Record<string, unknown>) {
  const res = await deps.fetch(API + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deps.env.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode(params),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** A Stripe customer id saved by the webhook (Lemon Squeezy's were numbers). */
const stripeCustomer = (row: any) => (typeof row?.customer_id === 'string' && row.customer_id.startsWith('cus_') ? row.customer_id : null);

export async function handleBilling(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await deps.getUser(req).catch(() => null);
  if (!user) return json(401, { error: 'Sign in first.' });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }

  if (body.action === 'portal') {
    const row = await deps.getPlanRow(user.id);
    const customer = stripeCustomer(row);
    if (!customer) {
      // A subscription from before Stripe: its saved portal link, if any.
      return row?.portal_url ? json(200, { url: row.portal_url }) : json(404, { error: 'No subscription on this account.' });
    }
    if (!deps.env.secretKey) return json(500, { error: 'Billing is not configured.' });
    const res = await stripe(deps, '/billing_portal/sessions', { customer, return_url: `${deps.env.site}/pricing/` });
    const url = res.body?.url;
    if (!res.ok || !url) {
      console.error('billing: portal', res.status, JSON.stringify(res.body?.error || res.body));
      return json(502, { error: `Couldn't open the subscription page. (${res.body?.error?.message || 'Stripe error ' + res.status})` });
    }
    return json(200, { url });
  }

  if (body.action === 'checkout') {
    const interval = body.interval === 'year' ? 'year' : 'month';
    const price = deps.env.prices[interval];
    if (!deps.env.secretKey || !price) return json(500, { error: 'Billing is not configured.' });
    const row = await deps.getPlanRow(user.id);
    if (row?.plan === 'premium' && ['active', 'trialing', 'past_due', 'on_trial'].includes(row.status)) return json(409, { error: 'You already have OnSketch Pro.' });
    const customer = stripeCustomer(row);
    const params: Record<string, unknown> = {
      mode: 'subscription',
      line_items: { 0: { price, quantity: 1 } },
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
      success_url: `${deps.env.site}/pricing/?welcome=1`,
      cancel_url: `${deps.env.site}/pricing/`,
      allow_promotion_codes: 'true',
    };
    if (customer) params.customer = customer;
    else if (user.email) params.customer_email = user.email;
    if (deps.env.automaticTax) {
      params.automatic_tax = { enabled: 'true' };
      params.billing_address_collection = 'required';
      if (customer) params.customer_update = { address: 'auto', name: 'auto' };
    }
    const res = await stripe(deps, '/checkout/sessions', params);
    const url = res.body?.url;
    if (!res.ok || !url) {
      console.error('billing: create checkout', res.status, JSON.stringify(res.body?.error || res.body));
      return json(502, { error: `Couldn't start the checkout. (${res.body?.error?.message || 'Stripe error ' + res.status})` });
    }
    return json(200, { url });
  }

  return json(400, { error: 'Unknown action.' });
}

declare const Deno: any;
if (typeof Deno !== 'undefined') {
  const { createClient } = await import('jsr:@supabase/supabase-js@2');
  const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY'), service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const env: Env = {
    secretKey: Deno.env.get('STRIPE_SECRET_KEY') || '',
    prices: { month: Deno.env.get('STRIPE_PRICE_MONTHLY') || '', year: Deno.env.get('STRIPE_PRICE_YEARLY') || '' },
    automaticTax: Deno.env.get('STRIPE_AUTOMATIC_TAX') === '1',
    site: (Deno.env.get('SITE_URL') || 'https://onsketch.io').replace(/\/$/, ''),
  };
  Deno.serve((req: Request) => handleBilling(req, {
    env, fetch,
    getUser: async (r: Request) => {
      const client = createClient(url, anon, { global: { headers: { Authorization: r.headers.get('Authorization') || '' } }, auth: { persistSession: false } });
      const { data } = await client.auth.getUser();
      return data?.user || null;
    },
    getPlanRow: async (userId: string) => (await admin.from('account_plans').select('*').eq('user_id', userId).maybeSingle()).data,
  }));
}

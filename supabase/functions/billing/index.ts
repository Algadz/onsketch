// Supabase Edge Function: billing
//
// Called by the signed-in app (Verify JWT ON, the default):
//   POST { action: 'checkout', interval: 'month' | 'year' }  → { url }
//     A Lemon Squeezy checkout for OnSketch Pro, with the user's id in
//     custom data (the webhook reads it back), their email pre-filled, and
//     a return to https://onsketch.io/pricing/?welcome=1 after paying.
//   POST { action: 'portal' }  → { url }
//     A fresh customer-portal link (manage, cancel, invoices; Lemon
//     Squeezy's links expire after a day, so they are fetched on demand).
//
// Secrets (Edge Functions → Secrets):
//   LEMONSQUEEZY_API_KEY   API key (Lemon Squeezy → Settings → API)
//   LEMONSQUEEZY_STORE_ID  numeric store id (Settings → Stores)
// Optional: LEMONSQUEEZY_MONTHLY_ID / LEMONSQUEEZY_YEARLY_ID (defaults
// below), SITE_URL (default https://onsketch.io).
// The ids may be variant ids or product ids: a product id is resolved to
// its first published variant.
// No imports at the top: tests run handleBilling() under Node.

const API = 'https://api.lemonsqueezy.com/v1';
const DEFAULT_IDS = { month: '1511078', year: '1511073' };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Env = { apiKey: string; storeId: string; ids: { month: string; year: string }; site: string };
type Deps = { env: Env; getUser: (req: Request) => Promise<any>; getPlanRow: (userId: string) => Promise<any>; fetch: typeof fetch };

async function ls(deps: Deps, path: string, init: RequestInit = {}) {
  const res = await deps.fetch(API + path, {
    ...init,
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: `Bearer ${deps.env.apiKey}`, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** A variant id from a variant or product id. */
export async function resolveVariant(deps: Deps, id: string): Promise<string | null> {
  const v = await ls(deps, `/variants/${encodeURIComponent(id)}`);
  if (v.ok && v.body?.data?.id) return String(v.body.data.id);
  const list = await ls(deps, `/variants?filter[product_id]=${encodeURIComponent(id)}`);
  const variants = (list.body?.data || []) as any[];
  const pick = variants.find(x => x.attributes?.status === 'published') || variants.find(x => x.attributes?.status !== 'pending') || variants[0];
  return pick ? String(pick.id) : null;
}

export async function handleBilling(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await deps.getUser(req).catch(() => null);
  if (!user) return json(401, { error: 'Sign in first.' });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }

  if (body.action === 'portal') {
    const row = await deps.getPlanRow(user.id);
    if (!row?.subscription_id) return json(404, { error: 'No subscription on this account.' });
    if (!deps.env.apiKey) return row.portal_url ? json(200, { url: row.portal_url }) : json(500, { error: 'Billing is not configured.' });
    const sub = await ls(deps, `/subscriptions/${encodeURIComponent(row.subscription_id)}`);
    const url = sub.body?.data?.attributes?.urls?.customer_portal || row.portal_url;
    return url ? json(200, { url }) : json(502, { error: "Couldn't reach the billing service." });
  }

  if (body.action === 'checkout') {
    const interval = body.interval === 'year' ? 'year' : 'month';
    if (!deps.env.apiKey || !deps.env.storeId) return json(500, { error: 'Billing is not configured.' });
    const row = await deps.getPlanRow(user.id);
    if (row?.plan === 'premium' && ['active', 'on_trial', 'past_due'].includes(row.status)) return json(409, { error: 'You already have OnSketch Pro.' });
    const variant = await resolveVariant(deps, deps.env.ids[interval]);
    if (!variant) return json(502, { error: 'This plan is not available right now.' });
    const res = await ls(deps, '/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: { email: user.email || undefined, custom: { user_id: user.id } },
            checkout_options: { embed: false, media: true, logo: true },
            product_options: { redirect_url: `${deps.env.site}/pricing/?welcome=1`, enabled_variants: [Number(variant)] },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(deps.env.storeId) } },
            variant: { data: { type: 'variants', id: String(variant) } },
          },
        },
      }),
    });
    const url = res.body?.data?.attributes?.url;
    if (!res.ok || !url) return json(502, { error: res.body?.errors?.[0]?.detail || "Couldn't start the checkout." });
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
    apiKey: Deno.env.get('LEMONSQUEEZY_API_KEY') || '',
    storeId: Deno.env.get('LEMONSQUEEZY_STORE_ID') || '',
    ids: { month: Deno.env.get('LEMONSQUEEZY_MONTHLY_ID') || DEFAULT_IDS.month, year: Deno.env.get('LEMONSQUEEZY_YEARLY_ID') || DEFAULT_IDS.year },
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

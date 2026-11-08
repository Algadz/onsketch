// Supabase Edge Function: lemonsqueezy-webhook
//
// Lemon Squeezy calls this URL on subscription events. It checks the
// X-Signature (HMAC-SHA256 of the raw body with the webhook's signing
// secret), logs the event in billing_events, and sets the user's plan in
// account_plans with the service role.
//
// Deploy with "Verify JWT" OFF (Lemon Squeezy doesn't send a Supabase
// token; the signature is the check). Secrets (Edge Functions → Secrets):
//   LEMONSQUEEZY_SIGNING_SECRET  the signing secret set on the webhook
//   LEMONSQUEEZY_LIVE_ONLY       optional: "1" once the store is live, so
//                                test-mode events are logged but no longer
//                                change anyone's plan
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// The user comes from the checkout's custom data (meta.custom_data.user_id),
// set by the "billing" function when it creates the checkout.
// No imports at the top: tests run handleWebhook() under Node.

/** Lemon Squeezy statuses that keep Pro on. "cancelled" keeps it until
 *  ends_at (plan_of() in SQL also enforces that date). */
const PRO_STATUSES = new Set(['on_trial', 'active', 'past_due', 'cancelled']);
const SUBSCRIPTION_EVENTS = new Set(['subscription_created', 'subscription_updated', 'subscription_cancelled',
  'subscription_resumed', 'subscription_expired', 'subscription_paused', 'subscription_unpaused',
  'subscription_payment_success', 'subscription_payment_failed', 'subscription_payment_recovered']);
/** OnSketch Pro in Lemon Squeezy (product or variant ids), to tell monthly from yearly. */
const INTERVAL_BY_ID: Record<string, string> = { '1511119': 'month', '1511125': 'year', '1511078': 'month', '1511073': 'year' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The account_plans row for a subscription object (data.attributes). */
export function planRow(userId: string, sub: any, testMode: boolean) {
  const a = sub.attributes || {};
  const status = String(a.status || '');
  const ends = a.ends_at ? new Date(a.ends_at) : null;
  const pro = PRO_STATUSES.has(status) && !(status === 'cancelled' && ends && ends.getTime() < Date.now());
  const name = `${a.variant_name || ''} ${a.product_name || ''}`.toLowerCase();
  return {
    user_id: userId,
    plan: pro ? 'premium' : 'free',
    status,
    interval: INTERVAL_BY_ID[String(a.variant_id)] || INTERVAL_BY_ID[String(a.product_id)] || (/year|annual/.test(name) ? 'year' : /month/.test(name) ? 'month' : null),
    renews_at: a.renews_at || null,
    ends_at: a.ends_at || null,
    portal_url: a.urls?.customer_portal || null,
    subscription_id: String(sub.id ?? ''),
    customer_id: a.customer_id != null ? String(a.customer_id) : null,
    test_mode: !!testMode,
    updated_at: new Date().toISOString(),
  };
}

/** `admin`: a service-role supabase client (or a test double with from()). */
export async function handleWebhook(req: Request, { secret, admin, liveOnly = false }: { secret: string; admin: any; liveOnly?: boolean }): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!secret) return new Response('Webhook secret not configured', { status: 500 });
  const raw = await req.text();
  const signature = (req.headers.get('x-signature') || '').toLowerCase();
  if (!signature || !sameText(await hmacHex(secret, raw), signature)) return new Response('Bad signature', { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  const event = String(body?.meta?.event_name || '');
  const userId = String(body?.meta?.custom_data?.user_id || '');
  const testMode = !!body?.meta?.test_mode;
  const sub = body?.data;

  await admin.from('billing_events').insert({
    event_name: event, user_id: UUID.test(userId) ? userId : null,
    subscription_id: sub?.type === 'subscriptions' ? String(sub.id) : null, test_mode: testMode, payload: body,
  });

  if (!SUBSCRIPTION_EVENTS.has(event) || sub?.type !== 'subscriptions') return new Response('Ignored', { status: 200 });
  if (!UUID.test(userId)) return new Response('No OnSketch user in custom data; logged', { status: 200 });
  if (liveOnly && testMode) return new Response('Test-mode event ignored (live only); logged', { status: 200 });

  const row = planRow(userId, sub, testMode);
  const { error } = await admin.from('account_plans').upsert(row, { onConflict: 'user_id' });
  if (error) return new Response('Database error: ' + error.message, { status: 500 });   // Lemon Squeezy retries
  return new Response('OK', { status: 200 });
}

declare const Deno: any;
if (typeof Deno !== 'undefined') {
  const { createClient } = await import('jsr:@supabase/supabase-js@2');
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  Deno.serve((req: Request) => handleWebhook(req, { secret: Deno.env.get('LEMONSQUEEZY_SIGNING_SECRET') || '', admin,
    liveOnly: Deno.env.get('LEMONSQUEEZY_LIVE_ONLY') === '1' }));
}

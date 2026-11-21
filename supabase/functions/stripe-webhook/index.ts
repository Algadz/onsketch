// Supabase Edge Function: stripe-webhook
//
// Stripe calls this URL on subscription events. It checks the
// Stripe-Signature header (HMAC-SHA256 of "timestamp.body" with the
// endpoint's signing secret, at most 5 minutes old), logs the event in
// billing_events, and sets the user's plan in account_plans with the
// service role.
//
// Deploy with "Verify JWT" OFF (Stripe doesn't send a Supabase token; the
// signature is the check). Secrets (Edge Functions → Secrets):
//   STRIPE_WEBHOOK_SECRET  whsec_… (Developers → Webhooks → the endpoint →
//                          Signing secret)
//   STRIPE_LIVE_ONLY       optional: "1" once live, so test-mode events are
//                          logged but no longer change anyone's plan
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// The user comes from the subscription's metadata.user_id, set by the
// "billing" function when it creates the checkout.
// No imports at the top: tests run handleWebhook() under Node.

/** Events that carry a subscription object. */
const SUBSCRIPTION_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed']);
/** Stripe statuses that keep Pro on. A subscription set to cancel at the
 *  period end stays Pro until then (saved as status 'cancelled' with
 *  ends_at, which plan_of() in SQL also enforces). */
const PRO_STATUSES = new Set(['trialing', 'active', 'past_due']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOLERANCE_S = 300;

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

/** Whether a Stripe-Signature header (t=…,v1=…[,v1=…]) signs `raw`. */
export async function verifySignature(header: string, raw: string, secret: string, now = Date.now()): Promise<boolean> {
  const parts = header.split(',').map(p => p.trim().split('='));
  const t = parts.find(p => p[0] === 't')?.[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1] || '');
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(now / 1000 - Number(t)) > TOLERANCE_S) return false;
  const want = await hmacHex(secret, `${t}.${raw}`);
  return sigs.some(s => sameText(want, s.toLowerCase()));
}

const iso = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : null);

/** The account_plans row for a Stripe subscription object. */
export function planRow(userId: string, sub: any, testMode: boolean) {
  const item = sub.items?.data?.[0] || {};
  // current_period_end is on the subscription in older API versions, on its items since 2025-03-31.
  const periodEnd = sub.current_period_end ?? item.current_period_end;
  const stripeStatus = String(sub.status || '');
  const ending = PRO_STATUSES.has(stripeStatus) && (sub.cancel_at_period_end || sub.cancel_at);
  const endsAt = ending ? iso(sub.cancel_at ?? periodEnd) : stripeStatus === 'canceled' ? iso(sub.ended_at ?? sub.canceled_at) : null;
  const pro = PRO_STATUSES.has(stripeStatus) && !(endsAt && new Date(endsAt).getTime() < Date.now());
  return {
    user_id: userId,
    plan: pro ? 'premium' : 'free',
    status: ending ? 'cancelled' : stripeStatus,
    interval: item.price?.recurring?.interval || item.plan?.interval || null,
    renews_at: pro && !ending ? iso(periodEnd) : null,
    ends_at: endsAt,
    portal_url: null,                       // portal sessions are made on demand (billing function)
    subscription_id: String(sub.id ?? ''),
    customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
    test_mode: !!testMode,
    updated_at: new Date().toISOString(),
  };
}

/** `admin`: a service-role supabase client (or a test double with from()). */
export async function handleWebhook(req: Request, { secret, admin, liveOnly = false, now = Date.now() }:
  { secret: string; admin: any; liveOnly?: boolean; now?: number }): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!secret) return new Response('Webhook secret not configured', { status: 500 });
  const raw = await req.text();
  if (!(await verifySignature(req.headers.get('stripe-signature') || '', raw, secret, now))) return new Response('Bad signature', { status: 401 });

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  const type = String(event?.type || '');
  const sub = event?.data?.object;
  const isSub = sub?.object === 'subscription';
  const userId = String((isSub ? sub?.metadata?.user_id : sub?.client_reference_id || sub?.metadata?.user_id) || '');
  const testMode = event?.livemode === false;

  await admin.from('billing_events').insert({
    event_name: type, user_id: UUID.test(userId) ? userId : null,
    subscription_id: isSub ? String(sub.id) : (typeof sub?.subscription === 'string' ? sub.subscription : null), test_mode: testMode, payload: event,
  });

  if (!SUBSCRIPTION_EVENTS.has(type) || !isSub) return new Response('Ignored', { status: 200 });
  if (!UUID.test(userId)) return new Response('No OnSketch user in the subscription metadata; logged', { status: 200 });
  if (liveOnly && testMode) return new Response('Test-mode event ignored (live only); logged', { status: 200 });

  const row = planRow(userId, sub, testMode);
  // Events can arrive out of order: an older subscription's event must not
  // undo a newer one (e.g. "deleted" for the old plan after a new one).
  let current: any = null;
  try { current = (await admin.from('account_plans').select('subscription_id,plan').eq('user_id', userId).maybeSingle()).data; } catch { /* no row */ }
  if (current?.plan === 'premium' && current.subscription_id && current.subscription_id !== row.subscription_id && row.plan !== 'premium') {
    return new Response('Older subscription; logged', { status: 200 });
  }
  const { error } = await admin.from('account_plans').upsert(row, { onConflict: 'user_id' });
  if (error) return new Response('Database error: ' + error.message, { status: 500 });   // Stripe retries
  return new Response('OK', { status: 200 });
}

declare const Deno: any;
if (typeof Deno !== 'undefined') {
  const { createClient } = await import('jsr:@supabase/supabase-js@2');
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  Deno.serve((req: Request) => handleWebhook(req, { secret: Deno.env.get('STRIPE_WEBHOOK_SECRET') || '', admin,
    liveOnly: Deno.env.get('STRIPE_LIVE_ONLY') === '1' }));
}

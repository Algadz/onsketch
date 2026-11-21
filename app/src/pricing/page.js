import { openCloud, isConfigured } from '../cloud/cloud.js';
import { mountAccount } from '../site/account.js';
import { notice } from '../ui/dialogs.js';
import { track, trackErrors } from '../ui/analytics.js';

/* =============== PRICING (/pricing/) ===========================
   Free vs OnSketch Pro (yearly only). The buttons depend on who is
   looking: signed out → sign in first (and come back here); free →
   checkout (Stripe Checkout, through the "billing" Edge Function); Pro →
   Manage subscription (Stripe customer portal). After paying, Stripe
   returns to /pricing/?welcome=1: the page waits for the webhook to
   switch the account to Pro.
   ============================================================ */
/** Pro is sold yearly only (one Stripe price); keep in step with it. */
const PRICE = { price: '$29', per: 'per year', sub: 'That is $2.42 a month, billed yearly, sales tax and VAT included. Cancel any time.' };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

class Pricing {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.interval = 'year';
    this.welcome = params.has('welcome');
    this.autostart = params.get('checkout');                 // set when coming back from sign-in
    this.user = null; this.plan = null; this.cloud = null;
  }

  /** The page words the plans: free sketches public only (private is
   *  Pro, cloud.rules()); the free-private wording stays for a later
   *  change of rule. */
  applyRules(freePrivate) {
    document.querySelectorAll('[data-rule]').forEach(el => { el.hidden = (el.dataset.rule === 'free-private') !== !!freePrivate; });
    this.freePrivate = !!freePrivate;
  }

  async start() {
    this.applyRules(false);
    mountAccount($('#site-account'));
    this.render();
    if (!isConfigured()) return;
    try {
      this.cloud = await openCloud({ createClient: window.__onsketchCreateClient || null });
      this.applyRules((await this.cloud.rules()).freePrivate);
      this.user = await this.cloud.user();
      if (this.user) this.plan = await this.cloud.plan();
    } catch { /* offline: the page still explains the plans */ }
    this.render();
    if (this.welcome) this.waitForPro();
    else if (this.autostart && this.user && this.plan?.plan !== 'premium') this.checkout('year');
    if (this.autostart || this.welcome) history.replaceState(null, '', location.pathname);
  }

  render() {
    const p = PRICE;
    $('[data-price]').textContent = p.price;
    $('[data-per]').textContent = p.per;
    $('[data-sub]').textContent = p.sub;

    const pro = this.plan?.plan === 'premium';
    const free = $('.pr-cta[data-plan="free"]'), proCta = $('.pr-cta[data-plan="pro"]');
    if (!this.user) {
      free.innerHTML = '<a class="btn" href="/app/">Start drawing</a>';
      proCta.innerHTML = `<a class="btn primary" data-umami-event="signin-prompt" data-umami-event-reason="pricing" href="/app/?signin&back=${encodeURIComponent(`/pricing/?checkout=${this.interval}`)}">Sign in to get Pro</a>
        <p class="pr-note">You'll come back here to pay.</p>`;
    } else if (pro) {
      free.innerHTML = '<span class="pr-current muted">Included in Pro</span>';
      const p2 = this.plan;
      const when = p2.status === 'cancelled' && p2.endsAt ? `Ends on ${day(p2.endsAt)}.`
        : p2.renewsAt ? `Renews on ${day(p2.renewsAt)}${p2.interval ? ` (${p2.interval === 'year' ? 'yearly' : 'monthly'})` : ''}.` : '';
      proCta.innerHTML = `<span class="pr-current">✓ Your plan</span><p class="pr-note">${esc(when)}</p>
        ${p2.hasSubscription ? '<button type="button" class="btn" data-a="portal">Manage subscription</button>' : ''}`;
      proCta.querySelector('[data-a="portal"]')?.addEventListener('click', (e) => this.portal(e.currentTarget));
    } else {
      free.innerHTML = '<span class="pr-current">✓ Your plan</span>';
      proCta.innerHTML = `<button type="button" class="btn primary" data-a="buy">Get Pro</button>
        <p class="pr-note">Secure checkout by Stripe.</p>`;
      proCta.querySelector('[data-a="buy"]').addEventListener('click', () => this.checkout(this.interval));
    }
  }

  async checkout(interval) {
    track('checkout-start', { interval, resumed: !!this.autostart });
    const btn = $('.pr-cta[data-plan="pro"] .btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening the checkout…'; }
    try { location.href = await this.cloud.billing('checkout', { interval }); }
    catch (e) { notice(e.message || "Couldn't open the checkout.", { kind: 'error', ms: 6000 }); this.render(); }
  }
  async portal(btn) {
    track('billing-open', { from: 'pricing' });
    btn.disabled = true; btn.textContent = 'Opening…';
    try { location.href = await this.cloud.billing('portal'); }
    catch (e) { notice(e.message || "Couldn't open the subscription page.", { kind: 'error', ms: 6000 }); btn.disabled = false; btn.textContent = 'Manage subscription'; }
  }

  /** After paying: the webhook usually lands within seconds. */
  async waitForPro() {
    const banner = $('#pr-banner');
    banner.hidden = false;
    banner.className = 'pr-banner';
    banner.textContent = 'Thank you! Activating OnSketch Pro…';
    for (let i = 0; i < 30 && this.plan?.plan !== 'premium'; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try { this.plan = await this.cloud.plan(); } catch { /* try again */ }
    }
    if (this.plan?.plan === 'premium') {
      banner.className = 'pr-banner ok';
      track('pro-activated');
      banner.innerHTML = 'OnSketch Pro is on: unlimited sketches. Thank you for supporting OnSketch.';
    } else {
      banner.className = 'pr-banner warn';
      banner.textContent = 'Your payment went through, but Pro is taking longer than usual to switch on. Reload this page in a minute; if it still says Free, use “Report a problem” in the editor.';
    }
    this.render();
  }
}

trackErrors('pricing');
const page = new Pricing();
window._pricing = page;
page.start();

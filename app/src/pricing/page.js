import { openCloud, isConfigured } from '../cloud/cloud.js';
import { mountAccount } from '../site/account.js';
import { notice } from '../ui/dialogs.js';
import { track, trackErrors } from '../ui/analytics.js';

/* =============== PRICING (/pricing/) ===========================
   Free vs OnSketch Pro, monthly / yearly. The buttons depend on who is
   looking: signed out → sign in first (and come back here); free →
   checkout (Lemon Squeezy, through the "billing" Edge Function); Pro →
   Manage subscription (customer portal). After paying, Lemon Squeezy
   returns to /pricing/?welcome=1: the page waits for the webhook to
   switch the account to Pro.
   ============================================================ */
const PRICES = {
  month: { price: '$9.99', per: 'per month', sub: 'Billed monthly. Cancel any time.' },
  year: { price: '$89', per: 'per year', sub: 'That is $7.42 a month, billed yearly. Cancel any time.' },
};
const RULES_KEY = 'onsketch:free-private';       // localStorage: '1' once the database allowed free private sketches
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

class Pricing {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.interval = params.get('interval') === 'month' ? 'month' : 'year';
    this.welcome = params.has('welcome');
    this.autostart = params.get('checkout');                 // set when coming back from sign-in
    this.user = null; this.plan = null; this.cloud = null;
  }

  /** The page words the plans as the database applies them: free
   *  sketches public only (the default), or private or public once
   *  plan_rules() says so (remembered, so the next visit doesn't flicker). */
  applyRules(freePrivate) {
    document.querySelectorAll('[data-rule]').forEach(el => { el.hidden = (el.dataset.rule === 'free-private') !== !!freePrivate; });
    this.freePrivate = !!freePrivate;
  }

  async start() {
    let known = false;
    try { known = localStorage.getItem(RULES_KEY) === '1'; } catch { /* storage unavailable */ }
    this.applyRules(known);
    mountAccount($('#site-account'));
    document.querySelectorAll('.pr-toggle [data-interval]').forEach(b => b.addEventListener('click', () => { this.interval = b.dataset.interval; track('pricing-interval', { interval: this.interval }); this.render(); }));
    this.render();
    if (!isConfigured()) return;
    try {
      this.cloud = await openCloud({ createClient: window.__onsketchCreateClient || null });
      const rules = await this.cloud.rules();
      this.applyRules(rules.freePrivate);
      try { localStorage.setItem(RULES_KEY, rules.freePrivate ? '1' : '0'); } catch { /* storage unavailable */ }
      this.user = await this.cloud.user();
      if (this.user) this.plan = await this.cloud.plan();
    } catch { /* offline: the page still explains the plans */ }
    this.render();
    if (this.welcome) this.waitForPro();
    else if (this.autostart && this.user && this.plan?.plan !== 'premium') this.checkout(this.autostart === 'month' ? 'month' : 'year');
    if (this.autostart || this.welcome) history.replaceState(null, '', location.pathname);
  }

  render() {
    document.querySelectorAll('.pr-toggle [data-interval]').forEach(b => b.setAttribute('aria-checked', b.dataset.interval === this.interval));
    const p = PRICES[this.interval];
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
      proCta.innerHTML = `<button type="button" class="btn primary" data-a="buy">Get Pro ${this.interval === 'year' ? 'yearly' : 'monthly'}</button>
        <p class="pr-note">Secure checkout by Lemon Squeezy.</p>`;
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

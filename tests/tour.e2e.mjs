// End-to-end test of the welcome tour (app/src/app/tour.js) and of the
// root page sending visitors straight to the editor, on desktop and phone.
//
// Usage: node tests/tour.e2e.mjs [rootDir]      SHOT_DIR=… for screenshots
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;
const base = `${origin}/app/`;

const browser = await chromium.launch();
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const errors = [];
const shot = (page, name) => process.env.SHOT_DIR && page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });

/** Opens a page as a real first visitor would (the tour is on). */
async function open(ctx, url = base, { tour = true } = {}) {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  page.on('console', m => { if (m.type() === 'error' && !/umami|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/umami|supabase|jsdelivr/, r => r.abort());
  await page.addInitScript((t) => {
    window.__ev = []; window.__onsketchTrack = (ev, data) => window.__ev.push({ ev, ...(data || {}) });
    if (t) window.__onsketchTour = true;
  }, tour);
  await page.goto(url);
  await page.waitForFunction(() => window._app);
  await page.waitForTimeout(300);
  return page;
}
const events = (page, name) => page.evaluate((n) => window.__ev.filter(e => e.ev === n), name);
const slideTitle = (page) => page.evaluate(() => document.querySelector('.tour-slide.on h2')?.textContent);

/* ---------------- The root page opens the editor ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await open(ctx, origin + '/?example=desk', { tour: false });
  await page.waitForFunction(() => window._app.activeSketch().entities.length > 4);
  check(new URL(page.url()).pathname === '/app/', 'onsketch.io/?example=desk goes straight to the editor and opens the example');
  const about = await ctx.newPage();
  await about.route(/umami|supabase|jsdelivr/, r => r.abort());
  const res = await about.goto(origin + '/about/');
  const imgOk = await about.evaluate(() => [...document.images].slice(0, 2).every(i => i.complete && i.naturalWidth > 0));
  check(res.ok() && /Paint, but to scale/.test(await about.title()) && imgOk, 'the former landing page lives at /about/, images loading');
  await ctx.close();
}

for (const phone of [false, true]) {
  const tag = phone ? 'phone' : 'desktop';
  const opts = phone ? { ...devices['iPhone 13'] } : { viewport: { width: 1400, height: 900 } };

  /* -------- First visit: three slides, then the first-run steps -------- */
  {
    const ctx = await browser.newContext(opts);
    const page = await open(ctx);
    await page.waitForSelector('.tour');
    check(!(await page.$('#guide')), `${tag}: a first visit opens the tour, not yet the steps`);
    check(await slideTitle(page) === 'Lock the sizes that matter', `${tag}: slide 1 is about locking sizes`);
    const text1 = await page.textContent('.tour-slide.on p');
    check(phone ? /tap a side/.test(text1) && !/\(D\)/.test(text1) : /\(D\)/.test(text1), `${tag}: slide 1 speaks of ${phone ? 'taps' : 'clicks and the D key'}`);
    await shot(page, `tour-1-${tag}`);
    await page.click('.tour [data-a="next"]');
    await page.waitForTimeout(400);
    check(await slideTitle(page) === 'Colour it, label it', `${tag}: Next shows slide 2`);
    await shot(page, `tour-2-${tag}`);
    await page.click('.tour [data-a="next"]');
    await page.waitForTimeout(1800);
    check(await slideTitle(page) === 'Take it anywhere' && await page.isVisible('.tour [data-a="example"]'), `${tag}: slide 3 offers an example (not opened)`);
    check(new URL(page.url()).search === '', `${tag}: no example was opened`);
    check(/example=linkage$/.test(await page.getAttribute('.tour [data-a="example"]', 'href')), `${tag}: the example offered is the linkage`);
    await shot(page, `tour-3-${tag}`);
    check(await page.textContent('.tour [data-a="next"]') === 'Start drawing', `${tag}: the last button is Start drawing`);
    await page.click('.tour [data-a="next"]');
    await page.waitForSelector('#guide');
    check(!(await page.$('.tour')) && /Draw a rectangle/.test(await page.textContent('#guide')), `${tag}: Start drawing closes the tour and shows step 1, Draw a rectangle`);
    const ev = (await events(page, 'tour')).map(e => e.step).join(',');
    check(ev === 'shown,lock,colour,export,done', `${tag}: tour events (${ev})`);
    await page.click('#guide [data-a="skip"]');
    await page.reload(); await page.waitForFunction(() => window._app); await page.waitForTimeout(500);
    check(!(await page.$('.tour')), `${tag}: the tour doesn't come back`);
    await ctx.close();
  }

  /* -------- Skip: no tour, no steps; the ? button brings it back -------- */
  {
    const ctx = await browser.newContext(opts);
    const page = await open(ctx);
    await page.waitForSelector('.tour');
    await page.click('.tour [data-a="skip"]');
    await page.waitForTimeout(300);
    check(!(await page.$('.tour')) && !(await page.$('#guide')), `${tag}: Skip closes the tour, and no steps follow`);
    const sk = (await events(page, 'tour')).find(e => e.step === 'skipped');
    check(sk && sk.at === 'lock' && sk.source === 'first', `${tag}: skipped is counted with the slide it happened on`);
    if (phone) { await page.click('#more-btn'); await page.click('#more-menu [data-more="tour"]'); }
    else await page.click('#menubar [data-action="tour"]');
    await page.waitForSelector('.tour');
    check((await events(page, 'tour')).some(e => e.step === 'shown' && e.source === 'help'), `${tag}: ${phone ? '⋯ → How OnSketch works' : 'the ? button'} opens it again`);
    if (!phone) {
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
      check(await slideTitle(page) === 'Take it anywhere' && await page.textContent('.tour [data-a="next"]') === 'Got it', 'desktop: arrow keys move through slides; from help the last button is Got it');
      await page.keyboard.press('Escape');
    } else {
      const b = await page.locator('.tour-view').boundingBox();
      await page.mouse.move(b.x + b.width - 30, b.y + 80); await page.mouse.down();
      await page.mouse.move(b.x + 30, b.y + 80); await page.mouse.up();
      await page.waitForTimeout(400);
      check(await slideTitle(page) === 'Colour it, label it', 'phone: a swipe goes to the next slide');
      await page.click('.tour [data-a="skip"]');
    }
    check(!(await page.$('.tour')) && !(await page.$('#guide')), `${tag}: closing it from help shows no steps`);
    await ctx.close();
  }
}

/* -------- Stylus option: only on a device where a pen was used -------- */
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  // A synthetic pen event has no real pointer to capture: that one error is expected.
  page.on('pageerror', e => { if (!/setPointerCapture/.test(String(e))) errors.push(String(e)); });
  await page.route(/umami|supabase|jsdelivr/, r => r.abort());
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')) { sessionStorage.setItem('x', '1'); localStorage.setItem('onsketch:stylus', '1'); } });
  await page.goto(base); await page.waitForFunction(() => window._app); await page.waitForTimeout(300);
  await page.tap('#more-btn');
  const st = await page.evaluate(() => ({ item: !!document.querySelector('#more-menu [data-more="stylus"]'), mode: window._app.stylusMode, cls: document.documentElement.classList.contains('stylus-mode') }));
  check(!st.item && !st.mode && !st.cls, 'phone, stylus mode saved but no pen ever used: no menu item, fingers still draw');
  await page.tap('#more-btn');
  await page.evaluate(() => {
    const c = document.getElementById('canvas'), r = c.getBoundingClientRect();
    const o = { pointerType: 'pen', pointerId: 7, isPrimary: true, clientX: r.left + 50, clientY: r.top + 50, bubbles: true };
    c.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerup', o));
  });
  await page.waitForTimeout(200);
  await page.tap('#more-btn');
  const pen = await page.evaluate(() => ({ item: !!document.querySelector('#more-menu [data-more="stylus"]'), mode: window._app.stylusMode, seen: localStorage.getItem('onsketch:pen-seen') }));
  check(pen.item && pen.mode === true && pen.seen === '1', 'once a pen is used: the item appears, with the choice saved before');
  await ctx.close();
}

/* -------- Library: its own menu-bar button, signed out too; the bar always fits -------- */
for (const w of [1100, 1280, 1920]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  const page = await open(ctx, base, { tour: false });
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => { const m = document.getElementById('menubar'), b = document.querySelector('#menubar [data-action="library"]'), a = document.getElementById('account-btn');
    const on = (e) => e && !e.hidden && e.getBoundingClientRect().right <= innerWidth;
    return { fits: m.scrollWidth <= m.clientWidth + 1, lib: on(b), label: getComputedStyle(b.querySelector('.btn-label')).display !== 'none', signIn: !a || a.hidden || (on(a) && getComputedStyle(a.querySelector('.btn-label') || a).display !== 'none') };
  });
  check(r.fits && r.lib && r.signIn && (w < 1600 || r.label), `${w} px, signed out: the menu bar fits, Library is on it${r.label ? ' with its label' : ' (icon)'}, Sign in visible`);
  if (w === 1920) {
    await page.click('#menubar [data-action="library"]');
    await page.waitForURL(/\/library\/$/);
    check(true, 'the Library button opens the library');
  }
  await ctx.close();
}

/* -------- Light / dark: every site page follows the editor's choice and has a toggle -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await open(ctx, base, { tour: false });
  await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('onsketch:prefs') || '{}'); p.theme = 'dark'; localStorage.setItem('onsketch:prefs', JSON.stringify(p)); });
  for (const path of ['/library/', '/app/projects/', '/pricing/', '/about/', '/privacy/', '/faq/']) {
    await page.goto(base.replace('/app/', path));
    await page.waitForSelector('.site-theme', { timeout: 8000 }).catch(() => {});
    const dark = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, btn: !!document.querySelector('.site-theme'), bg: getComputedStyle(document.body).backgroundColor }));
    let light = null;
    if (dark.btn) { await page.click('.site-theme'); light = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, saved: JSON.parse(localStorage.getItem('onsketch:prefs')).theme, bg: getComputedStyle(document.body).backgroundColor })); await page.click('.site-theme'); }
    check(dark.theme === 'dark' && dark.btn && light?.theme === 'light' && light.saved === 'light' && light.bg !== dark.bg,
      `${path}: opens dark like the editor, its ☀ toggle switches to light and saves it (${dark.bg} → ${light?.bg})`);
  }
  await ctx.close();
}

/* -------- A library link (?view=), or Insert (?insert=): no tour, no first-run steps -------- */
for (const q of ['?view=p1-abc', '?insert=p1-abc']) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await open(ctx, base + q);
  await page.waitForTimeout(800);
  check(!(await page.$('.tour')) && !(await page.isVisible('.guide')), `a new visitor opening a library link (${q}) gets no tour and no first-run steps`);
  await ctx.close();
}

/* -------- The linkage example: opens without the tour, one thing left free -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await open(ctx, base + '?example=linkage');
  await page.waitForFunction(() => window._app.activeSketch().entities.length > 5);
  await page.waitForTimeout(600);
  check(!(await page.$('.tour')), 'an example opens without the tour');
  check(/DOF: 1/.test(await page.textContent('#statusbar')), 'linkage: one degree of freedom left, the crank');
  const disp = await page.evaluate(() => ({ snap: window._app.snapOn, rel: window._app.showRelations }));
  check(!disp.snap && !disp.rel, 'linkage: opens with snap and relations off');
  // Change the crank from 30 to 40: the mechanism re-solves, the crank's circle follows (D7 = D1).
  const r = await page.evaluate(() => { const a = window._app, s = a.activeSketch(); const d1 = s.constraints.find(c => c.name === 'D1'); d1.value = 40; a._applyEquations(); a.solveAndRender(); const c = s.entities.find(e => e.constructor.kind === 'circle'); return { r: c.r, status: document.getElementById('statusbar').textContent }; });
  check(Math.abs(r.r - 40) < 1e-6 && /DOF: 1/.test(r.status), 'linkage: crank 30 → 40, its circle follows by equation');
  // A new sketch afterwards starts from this browser's own setup, not the example's.
  await page.click('#menubar [data-action="new"]');
  const dlg = page.locator('.app-dialog button', { hasText: 'Discard and start new' });
  if (await dlg.count()) await dlg.click();
  await page.waitForFunction(() => !window._app.activeSketch().entities.length);
  const after = await page.evaluate(() => ({ snap: window._app.snapOn, rel: window._app.showRelations }));
  check(after.snap && after.rel, 'a new sketch after the example has snap and relations back on');
  await ctx.close();
}

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);

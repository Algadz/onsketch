// Account and cloud projects in the editor, against an in-page fake of
// supabase-js (no network): sign in with the email code, save the drawing
// to the account, autosave, list / open / delete, conflicts, sign out.
// With --live it also checks the real project in app/src/cloud/config.js
// signed out (supabase-js loads, Google sign-in redirects to Supabase).
// Usage: node tests/cloud.e2e.mjs [--live]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const live = process.argv.includes('--live');
const root = resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}/app/`;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

/** In-page fake of supabase-js. Rows live in localStorage so a second tab
 *  (or a reload) sees the same "server". */
function installFake() {
  const DB = 'fake-sb:rows', SES = 'fake-sb:session';
  const rows = () => JSON.parse(localStorage.getItem(DB) || '[]');
  const put = (r) => localStorage.setItem(DB, JSON.stringify(r));
  const listeners = new Set();
  const session = () => JSON.parse(localStorage.getItem(SES) || 'null');
  const setSession = (s) => { if (s) localStorage.setItem(SES, JSON.stringify(s)); else localStorage.removeItem(SES); listeners.forEach(cb => cb(s ? 'SIGNED_IN' : 'SIGNED_OUT', s)); };
  window.__fakeSent = [];
  window.__onsketchCreateClient = () => ({
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      onAuthStateChange: (cb) => { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
      signInWithOtp: async ({ email }) => { window.__fakeSent.push(email); return { error: null }; },
      verifyOtp: async ({ email, token }) => {
        if (token !== '123456') return { data: {}, error: new Error('Token has expired or is invalid') };
        const s = { user: { id: 'u1', email } }; setSession(s); return { data: { user: s.user, session: s }, error: null };
      },
      signInWithOAuth: async () => ({ error: null }),
      signOut: async () => { setSession(null); return { error: null }; },
    },
    storage: { from: () => ({
      upload: async (path, blob) => {
        const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
        const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); files[path] = url;
        localStorage.setItem('fake-sb:files', JSON.stringify(files)); window.__fakeUploads = (window.__fakeUploads || 0) + 1;
        return { data: { path }, error: null };
      },
      remove: async (paths) => { const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); paths.forEach(p => delete files[p]); localStorage.setItem('fake-sb:files', JSON.stringify(files)); return { error: null }; },
      copy: async (a, b) => { const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); if (files[a]) files[b] = files[a]; localStorage.setItem('fake-sb:files', JSON.stringify(files)); return { error: null }; },
      createSignedUrls: async (paths) => { const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); return { data: paths.map(p => files[p] ? { path: p, signedUrl: files[p] } : { path: p, error: 'not found', signedUrl: null }), error: null }; },
    }) },
    from: (table) => {
      const q = { f: [], op: 'select', p: null, single: false, table };
      const run = () => {
        if (table === 'account_plans') return { data: null, error: null };
        const all = rows(); const m = r => q.f.every(([k, v]) => r[k] === v) && (q.notNull || []).every(k => r[k] != null) && (!q.text || [r.name, r.description].some(t => (t || '').toLowerCase().includes(q.text)));
        let out;
        if (q.op === 'insert' && q.table === 'projects' && all.length >= (window.__fakeLimit ?? 3)) return { data: null, error: new Error('OnSketch: free plan limit (3 projects).') };
        if (q.op === 'insert') { const r = { id: 'p' + (all.length + 1) + '-' + Date.now(), owner_id: 'u1', visibility: 'private', revision: 1, updated_at: new Date().toISOString(), ...q.p }; all.push(r); out = [r]; }
        else if (q.op === 'update') { out = all.filter(m); out.forEach(r => Object.assign(r, q.p, { revision: r.revision + ('data' in q.p ? 1 : 0), updated_at: new Date().toISOString() })); }
        else if (q.op === 'delete') { out = all.filter(m); put(all.filter(r => !m(r))); return { data: out, error: null }; }
        else { out = all.filter(m).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); if (q.range) out = out.slice(q.range[0], q.range[1] + 1); }
        if (q.op !== 'select') put(all);
        out = JSON.parse(JSON.stringify(out));
        if (q.single) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: Object.assign(new Error('not found'), { code: 'PGRST116' }) };
        return { data: out, error: null };
      };
      const b = {
        select() { return b; }, order() { return b; }, single() { q.single = true; return b; }, maybeSingle() { return b; },
        insert(p) { q.op = 'insert'; q.p = p; return b; }, update(p) { q.op = 'update'; q.p = p; return b; },
        delete() { q.op = 'delete'; return b; }, eq(k, v) { q.f.push([k, v]); return b; },
        not(k) { (q.notNull = q.notNull || []).push(k); return b; },
        or(expr) { q.text = /ilike\.%([^%]*)%/.exec(expr)[1].toLowerCase(); return b; },
        range(a, z) { q.range = [a, z]; return b; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
await ctx.addInitScript(installFake);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(base);
await page.waitForFunction(() => window._app);
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const app = (fn, arg) => page.evaluate(fn, arg);
const rowsOnServer = () => app(() => JSON.parse(localStorage.getItem('fake-sb:rows') || '[]'));

check(await page.isVisible('#account-btn') && (await page.textContent('#account-btn')).includes('Sign in'), 'account button says Sign in');

// Draw a rectangle, then sign in with the emailed code.
await page.keyboard.press('r');
await page.mouse.click(cx - 100, cy - 60); await page.mouse.click(cx + 80, cy + 50);
await page.keyboard.press('Escape');
await page.fill('#project-name', 'Shelf');
await page.click('#account-btn');
await page.waitForSelector('#account-modal.show input[type=email]');
check(await page.isVisible('#account-modal [data-a="google"]'), 'sign-in dialog offers Google');
await page.fill('#account-modal input[type=email]', 'me@example.com');
await page.click('#account-modal button[type=submit]');
await page.waitForSelector('#account-modal input[name=code]');
check((await app(() => window.__fakeSent)).includes('me@example.com'), 'sign-in email requested');
await page.fill('#account-modal input[name=code]', '000000');
await page.click('#account-modal button[type=submit]');
await page.waitForFunction(() => document.querySelector('#account-modal .account-msg.error'));
check(true, 'a wrong code shows an error');
await page.fill('#account-modal input[name=code]', '123456');
await page.click('#account-modal button[type=submit]');
await page.waitForSelector('#account-modal [data-a="upload"]');
check((await page.textContent('#account-modal')).includes('me@example.com'), 'signed in: projects dialog shows the email');
check(await page.locator('#account-btn .avatar').count() === 1, 'account button shows an avatar');

// Save the drawing to the account: title + description required.
await page.click('#account-modal [data-a="upload"]');
await page.waitForSelector('#details-modal');
check(await page.isVisible('#details-modal .details-preview canvas'), 'save dialog shows a preview');
check((await page.inputValue('#details-name')) === 'Shelf', 'title pre-filled from the project name');
await page.fill('#details-desc', 'too short');
check(await page.isDisabled('#details-modal [data-a="ok"]'), 'Save disabled with a 9-character description');
check((await page.textContent('#details-modal .counter')).includes('9 / 10'), 'counter shows 9 / 10 minimum');
await page.fill('#details-desc', 'Wall shelf, 80 cm, birch plywood');
await page.click('#details-modal [data-a="ok"]');
await page.waitForFunction(() => window._app.cloudLink && !document.getElementById('details-modal'));
let rows = await rowsOnServer();
check(rows.length === 1 && rows[0].name === 'Shelf' && rows[0].description === 'Wall shelf, 80 cm, birch plywood' && rows[0].visibility === 'public', 'saved with title, description, public');
check(rows[0].data.sketches[0].entities.length > 0, 'drawing saved to the account');
await page.waitForFunction(() => window.__fakeUploads >= 1, null, { timeout: 5000 });
check(true, 'preview uploaded after the first save');

// Autosave: a change is pushed a moment later.
await page.keyboard.press('c');
await page.mouse.click(cx + 200, cy); await page.mouse.click(cx + 250, cy);
await page.keyboard.press('Escape');
await page.waitForFunction(() => window._app.cloudLink && !window._app.cloudLink.dirty && window._app.cloudLink.revision > 1, null, { timeout: 8000 });
rows = await rowsOnServer();
check(rows[0].data.sketches[0].entities.some(e => e.type === 'circle'), `change pushed automatically (revision ${rows[0].revision})`);
check((await page.textContent('#account-btn')).includes('Saved'), 'account button says Saved');

// Another device saves first → conflict; keep mine.
await app(() => { const r = JSON.parse(localStorage.getItem('fake-sb:rows')); r[0].revision += 5; r[0].name = 'Shelf (laptop)'; localStorage.setItem('fake-sb:rows', JSON.stringify(r)); });
await page.fill('#project-name', 'Shelf v2');
await page.waitForSelector('#account-modal.show [data-a="mine"]', { timeout: 8000 });
check(true, 'a stale save asks which version to keep');
await page.click('#account-modal [data-a="mine"]');
await page.waitForFunction(() => !window._app.cloudLink.dirty);
rows = await rowsOnServer();
check(rows.length === 1 && rows[0].name === 'Shelf v2', 'Keep mine overwrites the other version');

// My sketches page: cards with preview, title, description, usage.
await page.goto(base + 'projects/');
await page.waitForSelector('.sketch-card[data-id]');
const card = await page.evaluate(() => {
  const c = document.querySelector('.sketch-card[data-id]');
  return { title: c.querySelector('.card-title').textContent, desc: c.querySelector('.card-desc').textContent,
    img: !!c.querySelector('.thumb img'), open: !!c.querySelector('.tag.open'), badge: c.querySelector('.tag.public')?.textContent,
    usage: document.getElementById('usage').textContent };
});
check(card.title === 'Shelf v2' && card.desc.includes('birch'), `card shows title and description (${card.title})`);
check(card.img, 'card shows the preview');
check(card.open && card.badge === 'Public', 'card marks the open drawing and the Public badge');
check(/1 of 3 sketches used/.test(card.usage), 'usage meter: 1 of 3');
check(await page.isVisible('.sketch-card.new'), 'a New sketch card while there is room');

// Edit details from the ⋯ menu.
await page.click('.sketch-card[data-id] .menu-btn');
await page.click('.card-menu [data-a="details"]');
await page.fill('#details-desc', 'Wall shelf, 90 cm, oak');
await page.click('#details-modal [data-a="ok"]');
await page.waitForFunction(() => document.querySelector('.card-desc')?.textContent.includes('oak'));
rows = await rowsOnServer();
check(rows[0].description === 'Wall shelf, 90 cm, oak' && rows[0].revision === (await app(() => JSON.parse(localStorage.getItem('onsketch:cloud')).revision)), 'Edit details saves without a revision bump the editor would trip on');

// Duplicate twice → limit reached → upsell card; duplicating again shows Premium.
for (let i = 0; i < 2; i++) {
  await page.click('.sketch-card[data-id] .menu-btn');
  await page.click('.card-menu [data-a="duplicate"]');
  await page.waitForFunction((n) => document.querySelectorAll('.sketch-card[data-id]').length === n, i + 2);
}
check(/3 of 3 sketches used/.test(await page.textContent('#usage')), 'usage meter: 3 of 3');
check(await page.isVisible('.sketch-card.upsell') && !(await page.isVisible('.sketch-card.new')), 'at the limit the New card becomes the upgrade card');
await page.click('.sketch-card[data-id] .menu-btn');
await page.click('.card-menu [data-a="duplicate"]');
await page.waitForSelector('text=Premium is coming');
check(true, 'a fourth sketch shows Premium');
await page.click('.modal-backdrop.show [data-a="ok"]');

// Delete a copy.
await page.locator('.sketch-card[data-id]', { hasText: '(copy)' }).first().locator('.menu-btn').click();
await page.click('.card-menu [data-a="delete"]');
await page.waitForFunction(() => document.querySelectorAll('.sketch-card[data-id]').length === 2);
check((await rowsOnServer()).length === 2, 'Delete removes it from the account');

// New sketch from the page: the linked drawing is put away, a fresh one opens.
await page.click('.sketch-card.new a');
await page.waitForFunction(() => window._app && window._app.cloudUser !== undefined);
await page.waitForFunction(() => window._app.cloudLink === null && window._app.activeSketch().entities.length === 0);
check(!/[?&]new/.test(page.url()), 'New sketch: fresh drawing, parameter cleaned');

// Open a sketch from its card.
await page.goto(base + 'projects/');
await page.waitForSelector('.sketch-card[data-id]');
await page.getByRole('link', { name: 'Shelf v2', exact: true }).click();
await page.waitForFunction(() => window._app?.project?.name === 'Shelf v2' && window._app.cloudLink);
check(await app(() => window._app.project.toJSON().sketches[0].entities.some(e => e.type === 'circle')), 'opened from My sketches, linked again');

// Phone width, dark theme: no sideways scrolling.
await page.setViewportSize({ width: 390, height: 820 });
await page.emulateMedia({ colorScheme: 'dark' });
await app(() => localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'dark' })));
await page.goto(base + 'projects/');
await page.waitForSelector('.sketch-card[data-id]');
check(await app(() => document.documentElement.scrollWidth <= 390 && document.documentElement.dataset.theme === 'dark'), 'My sketches fits a phone, follows the dark theme');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/projects-phone-dark.png', fullPage: true });
await page.setViewportSize({ width: 1400, height: 900 });
await app(() => localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })));
await page.goto(base);
await page.waitForFunction(() => window._app);

// A reload keeps the link and the session.
await page.reload();
await page.waitForFunction(() => window._app && window._app.cloudUser);
check(await app(() => window._app.cloudLink?.id) === rows[0].id, 'reload: still signed in and linked');

// Sign out keeps the drawing locally, unlinked.
await page.click('#account-btn');
await page.waitForSelector('#account-modal [data-a="signout"]');
await page.click('#account-modal [data-a="signout"]');
await page.waitForFunction(() => !window._app.cloudUser);
check(await app(() => window._app.cloudLink === null && window._app.project.name === 'Shelf v2'), 'sign out: drawing stays, unlinked');
check((await page.textContent('#account-btn')).includes('Sign in'), 'account button says Sign in again');
// Public library, signed out: the account's two sketches are listed.
await page.goto(base.replace('/app/', '/library/'));
await page.waitForSelector('.lib-card');
check((await page.locator('.lib-card').count()) === 2, 'library lists the public sketches');
check(await page.locator('.lib-card .thumb img').count() >= 1, 'library cards show previews');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/library.png' });
check(await app(() => document.documentElement.scrollWidth <= innerWidth), 'library: no sideways scrolling');
check((await page.textContent('#lib-account')) === 'Sign in', 'library: Sign in link when signed out');
await page.fill('#lib-search input[name=q]', 'copy');
await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 1);
check((await page.textContent('.lib-card .card-title')).includes('(copy)'), 'search narrows to matching sketches');
await page.fill('#lib-search input[name=q]', 'zzz-nothing');
await page.waitForFunction(() => /No sketch matches/.test(document.getElementById('page-msg').textContent));
check(true, 'search with no result says so');
await page.fill('#lib-search input[name=q]', '');
await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 2);
await page.locator('.lib-card .card-title a', { hasText: /^Shelf v2$/ }).click();
await page.waitForSelector('#lib-detail .lib-detail-desc');
check(/[?]s=/.test(page.url()) && (await page.textContent('#lib-detail h3')) === 'Shelf v2', 'detail view opens with a shareable ?s= link');
if (process.env.SHOT_DIR) {
  await page.screenshot({ path: process.env.SHOT_DIR + '/library-detail.png' });
  await page.setViewportSize({ width: 390, height: 820 });
  await page.screenshot({ path: process.env.SHOT_DIR + '/library-detail-phone.png' });
  await page.setViewportSize({ width: 1400, height: 900 });
}
await page.goBack();
await page.waitForFunction(() => !document.getElementById('lib-detail'));
check(true, 'Back closes the detail view');
await page.goForward();
await page.waitForSelector('#lib-detail a.btn.primary');
await page.click('#lib-detail a.btn.primary');
await page.waitForFunction(() => window._app?.project?.name === 'Shelf v2');
check(await app(() => window._app.cloudLink === null && window._app.project.toJSON().sketches[0].entities.some(e => e.type === 'circle')), 'Open a copy: the sketch opens in the editor, not linked to anyone\'s account');
check(!/view=/.test(page.url()), 'view parameter cleaned');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await ctx.close();

// Signed out, nothing cloud-related is downloaded.
{
  const c2 = await browser.newContext();
  const fetched = [];
  c2.on('request', r => { if (/jsdelivr|supabase/.test(r.url())) fetched.push(r.url()); });
  await c2.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
  const p2 = await c2.newPage();
  await p2.goto(base);
  await p2.waitForFunction(() => window._app);
  await p2.waitForTimeout(300);
  check(fetched.length === 0, 'first visit loads nothing from Supabase');
  await c2.close();
}

if (live) {
  const c3 = await browser.newContext();
  await c3.route(/umami/, r => r.abort());
  const p3 = await c3.newPage();
  const pageErrors = [];
  p3.on('pageerror', e => pageErrors.push(String(e)));
  await p3.goto(base);
  await p3.waitForFunction(() => window._app);
  await p3.click('#account-btn');
  await p3.waitForSelector('#account-modal [data-a="google"]', { timeout: 20000 });
  check(true, 'live: supabase-js loaded from the CDN, sign-in dialog shown');
  const nav = p3.waitForRequest(r => /\/auth\/v1\/authorize\?provider=google/.test(r.url()), { timeout: 20000 });
  await p3.route(/accounts\.google\.com|\/auth\/v1\/authorize/, r => r.abort());
  await p3.click('#account-modal [data-a="google"]');
  const req = await nav.catch(() => null);
  check(!!req && /redirect_to=http%3A%2F%2Flocalhost/.test(req.url()), 'live: Google sign-in goes to Supabase with a redirect back to the editor');
  await p3.goto(base.replace('/app/', '/library/'));
  await p3.waitForFunction(() => { const m = document.getElementById('page-msg'); return document.querySelector('.lib-card') || (m && !/Loading/.test(m.textContent) && m.textContent.trim()); }, null, { timeout: 20000 });
  const libState = await p3.evaluate(() => document.querySelectorAll('.lib-card').length + ' cards; ' + document.getElementById('page-msg').textContent.trim().slice(0, 60));
  check(!/Couldn't|error/i.test(libState), `live: library loads from the real project (${libState})`);
  check(pageErrors.length === 0, 'live: no page errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
  await c3.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall cloud checks passed');
process.exit(failed ? 1 : 0);

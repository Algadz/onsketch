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
    from: () => {
      const q = { f: [], op: 'select', p: null, single: false };
      const run = () => {
        const all = rows(); const m = r => q.f.every(([k, v]) => r[k] === v);
        let out;
        if (q.op === 'insert') { const r = { id: 'p' + (all.length + 1) + '-' + Date.now(), owner_id: 'u1', visibility: 'private', revision: 1, updated_at: new Date().toISOString(), ...q.p }; all.push(r); out = [r]; }
        else if (q.op === 'update') { out = all.filter(m); out.forEach(r => Object.assign(r, q.p, { revision: r.revision + 1, updated_at: new Date().toISOString() })); }
        else if (q.op === 'delete') { out = all.filter(m); put(all.filter(r => !m(r))); return { data: out, error: null }; }
        else out = all.filter(m).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        if (q.op !== 'select') put(all);
        out = JSON.parse(JSON.stringify(out));
        if (q.single) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: Object.assign(new Error('not found'), { code: 'PGRST116' }) };
        return { data: out, error: null };
      };
      const b = {
        select() { return b; }, order() { return b; }, single() { q.single = true; return b; },
        insert(p) { q.op = 'insert'; q.p = p; return b; }, update(p) { q.op = 'update'; q.p = p; return b; },
        delete() { q.op = 'delete'; return b; }, eq(k, v) { q.f.push([k, v]); return b; },
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

// Save the drawing to the account.
await page.click('#account-modal [data-a="upload"]');
await page.waitForSelector('#account-modal .project-list li.current');
let rows = await rowsOnServer();
check(rows.length === 1 && rows[0].name === 'Shelf' && rows[0].data.sketches[0].entities.length > 0, 'drawing saved to the account');
check(await app(() => window._app.cloudLink?.revision === 1), 'drawing linked to the cloud project');
await page.click('#account-modal [data-a="close"]');

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

// New project unlinks; open the cloud one again from the list.
await app(() => window._app.newProject());
check(await app(() => window._app.cloudLink === null), 'New project is browser-only');
await page.click('#account-btn');
await page.waitForSelector('#account-modal .project-list [data-a="open"]');
await page.click('#account-modal .project-list [data-a="open"]');
await page.waitForFunction(() => window._app.project.name === 'Shelf v2');
check(await app(() => window._app.project.toJSON().sketches[0].entities.some(e => e.type === 'circle') && !!window._app.cloudLink), 'opened from My projects, linked again');

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
  check(pageErrors.length === 0, 'live: no page errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
  await c3.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall cloud checks passed');
process.exit(failed ? 1 : 0);

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
  const listeners = new Set();
  const session = () => JSON.parse(localStorage.getItem(SES) || 'null');
  const SB_KEY = 'sb-rwmzpzaqijgdfsjmpqbd-auth-token';   // where the real supabase-js keeps the session
  const setSession = (s) => { if (s) { localStorage.setItem(SES, JSON.stringify(s)); localStorage.setItem(SB_KEY, JSON.stringify(s)); } else { localStorage.removeItem(SES); localStorage.removeItem(SB_KEY); } listeners.forEach(cb => cb(s ? 'SIGNED_IN' : 'SIGNED_OUT', s)); };
  window.__fakeSent = [];
  window.__onsketchCreateClient = () => ({
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      onAuthStateChange: (cb) => { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
      signInWithOtp: async ({ email }) => { window.__fakeSent.push(email); return { error: null }; },
      verifyOtp: async ({ email, token }) => {
        if (token !== '123456') return { data: {}, error: new Error('Token has expired or is invalid') };
        const s = { user: { id: email === 'me@example.com' ? 'u1' : 'u-' + email.split('@')[0], email } }; setSession(s); return { data: { user: s.user, session: s }, error: null };
      },
      signInWithOAuth: async () => ({ error: null }),
      signOut: async () => { setSession(null); return { error: null }; },
    },
    functions: { invoke: async (name, { body }) => {
      window.__billingCalls = [...(window.__billingCalls || []), { name, body }];
      if (name !== 'billing' || !session()) return { data: null, error: new Error('Unauthorized') };
      if (body.action === 'checkout') return { data: { url: `https://onsketch.lemonsqueezy.test/checkout/${body.interval}?user=${session().user.id}` }, error: null };
      if (body.action === 'portal') return { data: { url: 'https://onsketch.lemonsqueezy.test/billing' }, error: null };
      return { data: null, error: new Error('Unknown action') };
    } },
    rpc: async (fn, args) => {
      if (fn === 'public_profile') {
        const L = (k) => JSON.parse(localStorage.getItem(k) || '[]');
        const p = L('fake-sb:t:public_profiles').find(x => x.username && x.username.toLowerCase() === args.name.toLowerCase());
        if (!p) return { data: [], error: null };
        const mine = L('fake-sb:rows').filter(r => r.owner_id === p.user_id && r.visibility === 'public' && r.description != null);
        const likes = L('fake-sb:t:project_likes').filter(l => mine.some(r => r.id === l.project_id)).length;
        return { data: [{ user_id: p.user_id, username: p.username, avatar_url: p.avatar_url || null, bio: p.bio || null, country: p.country || null,
          website: p.website || null, joined_at: '2026-11-01T00:00:00Z', sketches: mine.length, likes }], error: null };
      }
      if (fn !== 'username_available') return { data: null, error: new Error('no such function') };
      const me = session()?.user?.id;
      const taken = JSON.parse(localStorage.getItem('fake-sb:t:public_profiles') || '[]')
        .some(p => p.username && p.username.toLowerCase() === args.name.toLowerCase() && p.user_id !== me);
      return { data: !taken, error: null };
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
      const KEY = table === 'projects' ? DB : 'fake-sb:t:' + table;
      const load = (k) => JSON.parse(localStorage.getItem(k) || '[]');
      const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
      const me = () => session()?.user?.id || null;
      const m = r => q.f.every(([k, v]) => r[k] === v) && (q.ins || []).every(([k, vs]) => vs.includes(r[k]))
        && (q.notNull || []).every(k => r[k] != null)
        && (!q.text || [r.name, r.description].some(t => (t || '').toLowerCase().includes(q.text)));
      const fail = (message, code) => ({ data: null, error: Object.assign(new Error(message), { code }) });
      const finish = (out) => {
        out = JSON.parse(JSON.stringify(out));
        if (q.maybe) return { data: out[0] || null, error: null };
        if (q.single) return out.length === 1 ? { data: out[0], error: null } : fail('not found', 'PGRST116');
        return { data: out, error: null };
      };
      const run = () => {
        if (table === 'account_plans') return finish(load('fake-sb:t:account_plans').filter(m));
        if (table === 'library_sketches') {
          const profiles = load('fake-sb:t:public_profiles'), likes = load('fake-sb:t:project_likes');
          let out = load(DB).filter(r => r.visibility === 'public' && r.description != null).map(r => {
            const a = profiles.find(x => x.user_id === r.owner_id);
            return { id: r.id, owner_id: r.owner_id, name: r.name, description: r.description, created_at: r.created_at || r.updated_at, updated_at: r.updated_at,
              author_name: a && a.username ? a.username : 'OnSketch user', author_avatar: a && a.username ? a.avatar_url : null, likes: likes.filter(l => l.project_id === r.id).length };
          }).filter(m);
          const [k, asc] = q.order || ['created_at', false];
          out.sort((a, b) => (asc ? 1 : -1) * (typeof a[k] === 'number' ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]))));
          if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
          return finish(out);
        }
        const all = load(KEY);
        let out;
        if (q.op === 'insert' || q.op === 'upsert') {
          if (table === 'projects') {
            const pro = load('fake-sb:t:account_plans').some(r => r.user_id === me() && r.plan === 'premium');
            if (!pro && all.filter(r => r.owner_id === me()).length >= (window.__fakeLimit ?? 3)) return fail('OnSketch: free plan limit (3 projects).');
            const now = new Date().toISOString();
            const r = { id: 'p' + (all.length + 1) + '-' + Date.now(), owner_id: me(), visibility: 'private', revision: 1, created_at: now, updated_at: now, ...q.p };
            all.push(r); out = [r];
          } else if (table === 'project_likes') {
            const p = load(DB).find(x => x.id === q.p.project_id);
            if (!p || p.visibility !== 'public' || p.owner_id === me()) return fail('new row violates row-level security policy', '42501');
            if (all.some(l => l.project_id === q.p.project_id && l.user_id === me())) return fail('duplicate key', '23505');
            out = [{ project_id: q.p.project_id, user_id: me() }]; all.push(out[0]);
          } else if (table === 'public_profiles') {
            const r = { user_id: me(), ...q.p };
            if (r.username && all.some(x => x.user_id !== r.user_id && (x.username || '').toLowerCase() === r.username.toLowerCase())) return fail('duplicate key', '23505');
            const i = all.findIndex(x => x.user_id === r.user_id);
            if (i >= 0 && q.op === 'insert') return fail('duplicate key', '23505');
            if (i >= 0) all[i] = { ...all[i], ...r }; else all.push(r);
            out = [all.find(x => x.user_id === r.user_id)];
          }
        } else if (q.op === 'update') {
          out = all.filter(m);
          out.forEach(r => Object.assign(r, q.p, table === 'projects' ? { revision: r.revision + ('data' in q.p ? 1 : 0), updated_at: new Date().toISOString() } : {}));
        } else if (q.op === 'delete') {
          out = all.filter(m); save(KEY, all.filter(r => !m(r))); return { data: out, error: null };
        } else {
          out = all.filter(m);
          if (table === 'project_likes' || table === 'public_profiles') out = table === 'project_likes' ? out.filter(l => l.user_id === me()) : out;
          if (table === 'projects') out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        }
        if (q.op !== 'select') save(KEY, all);
        return finish(out);
      };
      const b = {
        select() { return b; }, single() { q.single = true; return b; }, maybeSingle() { q.maybe = true; return b; },
        order(k, o) { if (!q.order) q.order = [k, !!(o && o.ascending)]; return b; },
        insert(p) { q.op = 'insert'; q.p = p; return b; }, upsert(p) { q.op = 'upsert'; q.p = p; return b; },
        update(p) { q.op = 'update'; q.p = p; return b; },
        delete() { q.op = 'delete'; return b; }, eq(k, v) { q.f.push([k, v]); return b; },
        in(k, vs) { (q.ins = q.ins || []).push([k, vs]); return b; },
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
const nativeDialogs = [];
page.on('dialog', d => { nativeDialogs.push(`${d.type()}: ${d.message()}`); d.dismiss(); });
await page.goto(base);
await page.waitForFunction(() => window._app);
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const app = (fn, arg) => page.evaluate(fn, arg);
const rowsOnServer = () => app(() => JSON.parse(localStorage.getItem('fake-sb:rows') || '[]'));

check(await page.isVisible('#account-btn') && (await page.textContent('#account-btn')).includes('Sign in'), 'account button says Sign in');
check(await app(() => ['New', 'Open', 'Save'].every(t => [...document.querySelectorAll('#menubar .file-btn')].some(b => !b.hidden && b.textContent.trim() === t))), 'File: New, Open and Save buttons with their text');
check(await app(() => !document.querySelector('[data-action="import"], [data-action="export"], #json-modal')), 'no Import / Export JSON any more');

// Draw a rectangle, then sign in with the emailed code.
await page.keyboard.press('r');
await page.mouse.click(cx - 100, cy - 60); await page.mouse.click(cx + 80, cy + 50);
await page.keyboard.press('Escape');
await page.fill('#project-name', 'Shelf');
await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Not saved');
check(true, 'a drawing only in this browser shows "Not saved"');

// New with an unsaved drawing asks in an app dialog: Cancel / Save it first / Discard.
await page.click('#menubar [data-action="new"]');
await page.waitForSelector('.app-dialog');
check(await app(() => [...document.querySelectorAll('.app-dialog .footer .btn')].map(b => b.textContent).join('|')) === 'Cancel|Save it first|Discard and start new',
  'New on an unsaved drawing: Cancel, Save it first, Discard and start new');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.app-dialog'));
check(await app(() => window._app.activeSketch().entities.length > 0), 'Escape cancels: the drawing stays');

// Signed out: no browser-save message, but a reload keeps the drawing.
await page.waitForTimeout(600);                                   // autosave
await page.reload();
await page.waitForFunction(() => window._app && window._app.activeSketch().entities.length > 0);
check(await app(() => window._app.project.name === 'Shelf'), 'signed out, a reload keeps the drawing');
check(!(await page.getAttribute('#menubar [data-action="save"]', 'title')).includes('browser'), 'the Save button no longer talks about the browser');

// Save while signed out asks to sign in (Ctrl+S too), then goes on with the save.
await page.keyboard.press('Control+s');
await page.waitForSelector('#account-modal.show input[type=email]');
check((await page.textContent('#account-modal h3')) === 'Sign in to save your sketch', 'Save (Ctrl+S) signed out asks to sign in');
check(!(await app(() => document.getElementById('status-solve').textContent)).includes('browser'), 'no "saved to browser" message');
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
check(await page.locator('#account-btn .avatar').count() === 1 || await page.waitForSelector('#account-btn .avatar').then(() => true), 'account button shows an avatar');

// Signed in from Save: first a public username (saving publishes on the free plan).
await page.waitForSelector('#profile-modal');
check((await page.textContent('#profile-heading')) === 'Choose your public username', 'saving asks for a public username first');
check((await page.inputValue('#profile-username')) === '', 'no username pre-filled from the account');
check(!(await page.isVisible('#profile-modal .picture-opt')), 'no picture option without an account picture');
await page.fill('#profile-username', 'Admin');
await page.waitForFunction(() => /reserved/.test(document.querySelector('.username-hint').textContent));
check(await page.isDisabled('#profile-modal [data-a="ok"]'), 'reserved username refused');
await page.fill('#profile-username', 'alban.m');
await page.waitForFunction(() => /available/.test(document.querySelector('.username-hint').textContent));
check(true, 'username availability is checked as you type');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/profile-dialog.png', clip: { x: 400, y: 200, width: 600, height: 500 } });
await page.click('#profile-modal [data-a="ok"]');

// Then the save goes on: title + description required.
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
check((await page.textContent('#save-state')) === 'Saved', 'Saved shown next to the Save button');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/menubar.png', clip: { x: 0, y: 0, width: 1400, height: 48 } });
await page.keyboard.press('Control+s');
await page.waitForFunction(() => document.getElementById('status-solve').textContent === 'Saved');
check(!(await page.isVisible('#account-modal.show')) && !(await page.isVisible('#details-modal')), 'Save signed in saves at once, no dialog');

// Another device saves first → conflict; keep mine.
await app(() => { const r = JSON.parse(localStorage.getItem('fake-sb:rows')); r[0].revision += 5; r[0].name = 'Shelf (laptop)'; localStorage.setItem('fake-sb:rows', JSON.stringify(r)); });
await page.fill('#project-name', 'Shelf v2');
await page.waitForSelector('#account-modal.show [data-a="mine"]', { timeout: 8000 });
check(true, 'a stale save asks which version to keep');
await page.click('#account-modal [data-a="mine"]');
await page.waitForFunction(() => !window._app.cloudLink.dirty);
rows = await rowsOnServer();
check(rows.length === 1 && rows[0].name === 'Shelf v2', 'Keep mine overwrites the other version');

// Open (Ctrl+O): the account's sketches with previews; opening one links it.
await app(() => window._app.newProject());
check(await app(() => window._app.cloudLink === null) && (await page.textContent('#save-state')) === '', 'New: a fresh sketch without a confirmation (the previous one is saved)');
await page.keyboard.press('Control+o');
await page.waitForSelector('#account-modal.show .open-item');
check((await page.textContent('#account-modal h3')) === 'Open a sketch' && await page.locator('#account-modal .open-item').count() === 1, 'Open lists the saved sketches');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/open-dialog.png' });
await page.click('#account-modal .open-item');
await page.waitForFunction(() => window._app.cloudLink && window._app.project.name === 'Shelf v2');
check(!(await page.isVisible('#account-modal.show')), 'clicking a sketch opens it and closes the dialog');

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
await page.waitForURL(/\/pricing\/$/);
check(true, 'a fourth sketch leads to the pricing page');
await page.goBack();
await page.waitForSelector('.sketch-card[data-id]');

// Delete a copy.
await page.locator('.sketch-card[data-id]', { hasText: '(copy)' }).first().locator('.menu-btn').click();
await page.click('.card-menu [data-a="delete"]');
await page.waitForSelector('.app-dialog .btn.danger');
check(/^Delete ".*\(copy\)"\?$/.test(await page.textContent('#app-dialog-title')) && await app(() => document.activeElement?.textContent === 'Cancel'),
  'Delete asks in an app dialog, with the focus on Cancel');
await page.click('.app-dialog .btn.danger');
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

// Account menu (avatar): username, My sketches, Library, profile, sign out.
await page.click('#account-btn');
await page.waitForSelector('#account-menu:not([hidden])');
check(await app(() => { const m = document.getElementById('account-menu'); return m.textContent.includes('@alban.m') && m.textContent.includes('me@example.com')
  && ['My sketches', 'Library', 'Edit public profile…', 'View my public profile', 'Sketch details…', 'Sign out'].every(t => [...m.querySelectorAll('.am-item')].some(i => i.textContent.trim() === t)); }),
  'avatar opens a menu: @username, My sketches, Library, Edit / View public profile, Sketch details, Sign out');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/account-menu.png', clip: { x: 1000, y: 0, width: 400, height: 380 } });
await page.keyboard.press('Escape');
check(await page.isHidden('#account-menu'), 'Escape closes the menu');
await page.click('#account-btn');
await page.click('#account-menu [data-a="profile"]');
await page.waitForSelector('#profile-modal');
check((await page.inputValue('#profile-username')) === 'alban.m', 'Public profile shows the username');
check(await page.isVisible('#profile-bio') && await page.isVisible('#profile-country') && await page.isVisible('#profile-website'), 'profile has About you, Country and Website');
if (process.env.SHOT_DIR) { await page.fill('#profile-bio', 'Furniture maker in Lyon.'); await page.selectOption('#profile-country', 'FR'); await page.fill('#profile-website', 'example.com/alban'); await page.screenshot({ path: process.env.SHOT_DIR + '/profile-edit.png' }); }
await page.fill('#profile-bio', 'Furniture maker in Lyon. Desks, shelves and beds.');
await page.selectOption('#profile-country', 'FR');
await page.fill('#profile-website', 'javascript:alert(1)');
await page.click('#profile-modal [data-a="ok"]');
check(/website/i.test(await page.textContent('#profile-modal .account-msg')), 'a javascript: link is refused');
await page.fill('#profile-website', 'example.com/alban');
await page.click('#profile-modal [data-a="ok"]');
await page.waitForFunction(() => !document.getElementById('profile-modal'));
check(await app(() => { const p = JSON.parse(localStorage.getItem('fake-sb:t:public_profiles')).find(x => x.username === 'alban.m');
  return p.country === 'FR' && p.website === 'https://example.com/alban' && /Lyon/.test(p.bio); }), 'profile saved: bio, country, website (https added)');
await page.click('#account-btn');
check(await page.getAttribute('#account-menu a[href^="/library/?u="]', 'href') === '/library/?u=alban.m', 'account menu: View my public profile');
await page.keyboard.press('Escape');

// The public profile page: /library/?u=<username> (any case).
await page.goto(base.replace('/app/', '/library/?u=ALBAN.M'));
await page.waitForSelector('.lp-card');
const prof = await app(() => ({ name: document.querySelector('.lp-main h2').textContent, bio: document.querySelector('.lp-bio')?.textContent,
  facts: document.querySelector('.lp-facts').textContent, rel: document.querySelector('.lp-facts a')?.rel,
  stats: document.querySelector('.lp-stats').textContent.replace(/\s+/g, ' ').trim(), cards: document.querySelectorAll('.lib-card').length, title: document.title }));
check(prof.name === '@alban.m' && /Lyon/.test(prof.bio) && /🇫🇷/.test(prof.facts) && /example\.com\/alban/.test(prof.facts) && /Joined/.test(prof.facts),
  `profile page: @username, bio, flag and country, website, joined (${prof.facts.replace(/\s+/g, ' ').trim()})`);
check(prof.rel === 'nofollow ugc noopener', 'website link is nofollow ugc noopener');
check(prof.cards === 2 && /^2\s*sketches/.test(prof.stats) && prof.title === '@alban.m - OnSketch', `profile page: their public sketches and totals (${prof.stats})`);
check(/This is your public profile/.test(await page.textContent('#lib-profile')), 'your own profile says so');
if (process.env.SHOT_DIR) { await page.screenshot({ path: process.env.SHOT_DIR + '/profile-page.png', clip: { x: 0, y: 0, width: 1400, height: 760 } }); }
await page.locator('.lib-card .card-title a').first().click();
await page.waitForSelector('#lib-detail h3');
check(/[?]u=ALBAN\.M&s=/.test(page.url()), 'detail view keeps the profile in the URL');
await page.keyboard.press('Escape');
await page.goto(base.replace('/app/', '/library/?u=nobody-here'));
await page.waitForSelector('.lp-empty');
check(/No one here/.test(await page.textContent('.lp-empty')), 'unknown username: "No one here"');
await page.goto(base.replace('/app/', '/library/'));
await page.waitForSelector('.lib-card a.author-name');
await page.locator('.lib-card a.author-name').first().click();
await page.waitForURL(/\/library\/\?u=alban\.m$/);
check(true, 'the author on a library card links to their profile');
await page.goto(base);
await page.waitForFunction(() => window._app?.cloudUser);
await page.goto(base.replace('/app/', '/library/'));
await page.waitForSelector('.lib-card .author-name');
check((await page.textContent('.lib-card .author-name')) === 'alban.m', 'library shows the chosen username');
check(await page.locator('.lib-card .like-btn[disabled]').count() === 2, 'no thumbs-up on your own sketches');
await page.goto(base);
await page.waitForFunction(() => window._app && window._app.cloudUser);

// Sign out keeps the drawing locally, unlinked.
await page.click('#account-btn');
await page.click('#account-menu [data-a="signout"]');
await page.waitForFunction(() => !window._app.cloudUser);
check(await app(() => window._app.cloudLink === null && window._app.project.name === 'Shelf v2'), 'sign out: drawing stays, unlinked');
check((await page.textContent('#account-btn')).includes('Sign in'), 'account button says Sign in again');

// Open while signed out: sign in first, then the list.
await page.click('#menubar [data-action="open"]');
await page.waitForSelector('#account-modal.show input[type=email]');
check((await page.textContent('#account-modal h3')) === 'Sign in to open your sketches', 'Open signed out asks to sign in');
await page.fill('#account-modal input[type=email]', 'me@example.com');
await page.click('#account-modal button[type=submit]');
await page.fill('#account-modal input[name=code]', '123456');
await page.click('#account-modal button[type=submit]');
await page.waitForSelector('#account-modal.show .open-item');
check((await page.textContent('#account-modal h3')) === 'Open a sketch', 'after signing in, the Open list appears');
await page.click('#account-modal [data-a="close"]');
await page.click('#account-btn');
await page.click('#account-menu [data-a="signout"]');
await page.waitForFunction(() => !window._app.cloudUser);
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

// Thumbs-up: signed out it asks to sign in; another user can like, once, and undo.
await page.goto(base.replace('/app/', '/library/'));
await page.waitForSelector('.lib-card .like-btn');
await page.locator('.lib-card', { hasText: /Shelf v2\s/ }).first().locator('.like-btn').click();
await page.waitForFunction(() => window._app && document.querySelector('#account-modal.show input[type=email]'));
check(true, 'signed out, the thumbs-up opens sign-in');
await page.fill('#account-modal input[type=email]', 'other@example.com');
await page.click('#account-modal button[type=submit]');
await page.waitForSelector('#account-modal input[name=code]');
await page.fill('#account-modal input[name=code]', '123456');
await page.click('#account-modal button[type=submit]');
await page.waitForFunction(() => window._app.cloudUser?.email === 'other@example.com');
await page.waitForSelector('#profile-modal');
check((await page.textContent('#profile-heading')) === 'Choose your public username', 'first sign-in asks for a public username');
await page.fill('#profile-username', 'ALBAN.M');
await page.waitForFunction(() => /taken/.test(document.querySelector('.username-hint').textContent));
check(true, "someone else's username is taken, ignoring case");
await page.click('#profile-modal [data-a="cancel"]');
await page.waitForURL(/\/library\//);
check(true, '"Later" skips it, and sign-in from the library returns to the library');
await page.goto(base.replace('/app/', '/library/'));
const shelf = () => page.locator('.lib-card').filter({ has: page.locator('.card-title', { hasText: /^Shelf v2$/ }) });
await shelf().locator('.like-btn:not([disabled])').waitFor();
await shelf().locator('.like-btn').click();
await page.waitForFunction(() => JSON.parse(localStorage.getItem('fake-sb:t:project_likes') || '[]').length === 1);
check((await shelf().locator('.like-count').textContent()) === '1' && await shelf().locator('.like-btn.on').count() === 1, 'thumbs-up counts 1 and shows as given');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/library-likes.png' });
await page.reload();
await shelf().locator('.like-btn.on').waitFor();
check((await shelf().locator('.like-count').textContent()) === '1', 'after a reload the thumbs-up is still yours');
await page.selectOption('#lib-search select[name=sort]', 'popular');
await page.waitForFunction(() => document.querySelector('.lib-card .card-title')?.textContent === 'Shelf v2');
check(true, 'Most liked puts it first');
await shelf().locator('.card-title a').click();
await page.waitForSelector('#lib-detail .like-btn.on');
check((await page.textContent('#lib-detail .author-name')) === 'alban.m', 'detail view shows the author and the thumbs-up');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/library-detail-likes.png' });
await page.click('#lib-detail .like-btn');
await page.waitForFunction(() => JSON.parse(localStorage.getItem('fake-sb:t:project_likes') || '[]').length === 0);
check((await page.textContent('#lib-detail .like-count')) === '0', 'clicking again takes the thumbs-up back');
await page.keyboard.press('Escape');

// Landing page: account menu when signed in, Sign in (and back) when signed out.
const home = base.replace('/app/', '/');
await page.goto(home);
await page.waitForSelector('#site-account .site-acc-btn');
await page.click('#site-account .site-acc-btn');
check(await app(() => { const m = document.querySelector('#site-account .site-acc-menu'); return !m.hidden && m.textContent.includes('other@example.com')
  && ['My sketches', 'Library', 'Open the editor', 'Sign out'].every(t => [...m.querySelectorAll('a, button')].some(i => i.textContent.trim() === t)); }),
  'landing page: avatar menu with My sketches, Library, Open the editor, Sign out');
await page.click('#site-account [data-a="signout"]');
await page.waitForSelector('#site-account .site-acc-signin');
check(await app(() => !localStorage.getItem('fake-sb:session')), 'landing page: Sign out signs out');
check(/back=%2F$/.test(await page.getAttribute('#site-account .site-acc-signin', 'href')), 'landing page: Sign in link comes back here');
await page.click('#site-account .site-acc-signin');
await page.waitForSelector('#account-modal.show input[type=email]');
await page.fill('#account-modal input[type=email]', 'me@example.com');
await page.click('#account-modal button[type=submit]');
await page.fill('#account-modal input[name=code]', '123456');
await page.click('#account-modal button[type=submit]');
await page.waitForURL(home);
await page.waitForFunction(() => /@alban\.m/.test(document.querySelector('#site-account .site-acc-head')?.textContent || ''));
check(true, 'signing in from the landing page returns to it, showing @username');
if (process.env.SHOT_DIR) { await page.click('#site-account .site-acc-btn'); await page.screenshot({ path: process.env.SHOT_DIR + '/landing-menu.png', clip: { x: 700, y: 0, width: 700, height: 340 } }); }
if (process.env.SHOT_DIR) await page.keyboard.press('Escape');

// Pricing: free user → checkout through the billing function.
await page.route(/lemonsqueezy\.test/, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>checkout</title>' }));
await page.goto(base.replace('/app/', '/pricing/'));
await page.waitForSelector('.pr-cta[data-plan="pro"] [data-a="buy"]');
check((await page.textContent('[data-price]')) === '$89' && /7\.42/.test(await page.textContent('[data-sub]')), 'pricing: yearly by default, $89 ($7.42 a month)');
await page.click('.pr-toggle [data-interval="month"]');
check((await page.textContent('[data-price]')) === '$9.99' && (await page.textContent('.pr-cta[data-plan="pro"] .btn')) === 'Get Pro monthly', 'pricing: monthly $9.99');
check((await page.textContent('.pr-cta[data-plan="free"]')).includes('Your plan'), 'pricing: Free marked as your plan');
await page.click('.pr-cta[data-plan="pro"] [data-a="buy"]');
await page.waitForURL(/lemonsqueezy\.test\/checkout\/month\?user=u1/);
check(true, 'Get Pro opens the Lemon Squeezy checkout for this user, monthly');

// Back from paying: the page waits for the webhook, then shows Pro.
await page.goto(base.replace('/app/', '/pricing/?welcome=1'));
await page.waitForSelector('#pr-banner:not([hidden])');
check(/Activating/.test(await page.textContent('#pr-banner')), 'after paying: "Activating OnSketch Pro…"');
await app(() => localStorage.setItem('fake-sb:t:account_plans', JSON.stringify([{ user_id: 'u1', plan: 'premium', status: 'active', interval: 'month',
  renews_at: '2026-12-08T00:00:00Z', ends_at: null, subscription_id: '987' }])));
await page.waitForFunction(() => document.getElementById('pr-banner').classList.contains('ok'), null, { timeout: 10000 });
check(/Pro is on/.test(await page.textContent('#pr-banner')) && !/welcome/.test(page.url()), 'the webhook lands: "OnSketch Pro is on", URL cleaned');
check(/Renews on/.test(await page.textContent('.pr-cta[data-plan="pro"]')), 'pricing as Pro: your plan, with the renewal date');
await page.click('.pr-cta[data-plan="pro"] [data-a="portal"]');
await page.waitForURL(/lemonsqueezy\.test\/billing/);
check(true, 'Manage subscription opens the customer portal');

// Pro in My sketches and the editor: no limit, private sketches.
await page.goto(base + 'projects/');
await page.waitForSelector('.sketch-card[data-id]');
check(/OnSketch Pro/.test(await page.textContent('#usage')) && await page.isVisible('#usage [data-a="billing"]'), 'My sketches as Pro: no limit, Manage subscription');
await page.locator('.sketch-card[data-id]').first().locator('.menu-btn').click();
await page.click('.card-menu [data-a="private"]');
await page.waitForSelector('.sketch-card .tag.private');
check(await app(() => JSON.parse(localStorage.getItem('fake-sb:rows')).some(r => r.visibility === 'private')), 'Make private: the sketch is private');
await page.goto(base);
await page.waitForFunction(() => window._app?.cloudUser);
await page.click('#account-btn');
await page.waitForFunction(() => /OnSketch Pro/.test(document.querySelector('#account-menu .am-plan')?.textContent || ''));
check(await page.isVisible('#account-menu [data-a="billing"]') && !(await page.isVisible('#account-menu .am-pro')), 'account menu as Pro: Manage subscription, no Upgrade');
await page.keyboard.press('Escape');

// Signed out: Sign in to get Pro, back to the checkout.
await app(() => localStorage.setItem('fake-sb:t:account_plans', '[]'));
await page.click('#account-btn');
await page.click('#account-menu [data-a="signout"]');
await page.waitForFunction(() => !window._app.cloudUser);
await page.goto(base.replace('/app/', '/pricing/'));
await page.waitForSelector('.pr-cta[data-plan="pro"] a.btn');
check(/back=%2Fpricing%2F%3Fcheckout%3Dyear/.test(await page.getAttribute('.pr-cta[data-plan="pro"] a.btn', 'href')), 'pricing signed out: Sign in to get Pro, then back to the checkout');
if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/pricing.png', fullPage: true });

check(nativeDialogs.length === 0, 'no browser pop-ups (confirm / alert / prompt)' + (nativeDialogs.length ? ': ' + nativeDialogs.join(' | ') : ''));
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await ctx.close();

// Start-up: while the modules load, only a clean shell in the saved theme shows.
{
  const c4 = await browser.newContext({ colorScheme: 'dark' });
  await c4.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
  const p4 = await c4.newPage();
  let release; const gate = new Promise(r => { release = r; });
  await p4.route(/\/src\/main\.js/, async r => { await gate; r.continue(); });
  p4.goto(base).catch(() => {});
  await p4.waitForSelector('#menubar');
  const during = await p4.evaluate(() => ({ booting: document.documentElement.classList.contains('booting'), theme: document.documentElement.dataset.theme,
    win: getComputedStyle(document.querySelector('.fwin')).visibility, btn: getComputedStyle(document.querySelector('#menubar [data-action="save"]')).visibility }));
  check(during.booting && during.theme === 'dark' && during.win === 'hidden' && during.btn === 'hidden', `start-up: windows and buttons hidden, theme set before the editor loads (${JSON.stringify(during)})`);
  release();
  await p4.waitForFunction(() => window._app && !document.documentElement.classList.contains('booting'));
  check(await p4.evaluate(() => getComputedStyle(document.querySelector('.fwin')).visibility === 'visible'), 'start-up: everything shows once the editor is ready');
  await c4.close();
}

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
  await p2.setViewportSize({ width: 390, height: 800 });
  await p2.goto(base.replace('/app/', '/'));
  await p2.waitForSelector('#site-account .site-acc-signin');
  check(fetched.length === 0 && await p2.evaluate(() => document.documentElement.scrollWidth <= 390), 'landing page signed out: Sign in, nothing loaded from Supabase, fits a phone');
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
  check(!/couldn't|could not|error|not find/i.test(libState), `live: library loads from the real project (${libState})`);
  check(pageErrors.length === 0, 'live: no page errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
  await c3.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall cloud checks passed');
process.exit(failed ? 1 : 0);

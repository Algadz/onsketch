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
import { installFake } from './fake-supabase.mjs';
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
check(await app(() => !document.querySelector('[data-action="import"], #json-modal')), 'no Import / Export JSON any more');
check(await app(() => { const b = document.querySelector('#menubar .file-btn[data-action="export"]'); return !!b && b.textContent.trim() === 'Export'; }), 'File: Export (images, DXF, print to scale)');

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
// Insert: the saved sketch as a part inside the open drawing.
await page.click('#account-modal [data-insert]');
await page.waitForFunction(() => window._app.activeSketch().entities.length > 0);
const ins = await app(() => {
  const a = window._app, s = a.activeSketch();
  const ids = []; const seen = new Set();
  const walk = (e) => { if (seen.has(e)) return; seen.add(e); ids.push(e.id); e.children().forEach(walk); };
  s.entities.forEach(walk);
  return { linked: !!a.cloudLink, name: a.project.name, layers: a.project.layers.map(l => l.name), n: s.entities.length,
    selected: s.entities.filter(e => e.selected).length, unique: new Set(ids).size === ids.length, tool: a.toolName,
    pinned: s.constraints.some(c => c.kind === 'fix'), dialog: document.querySelector('#account-modal.show') !== null };
});
check(ins.n > 0 && !ins.linked && ins.name !== 'Shelf v2' && ins.layers.includes('Shelf v2') && !ins.dialog,
  `Open ▸ Insert: the sketch arrives as a part on its own layer, the drawing stays the open one (${ins.layers.join(', ')})`);
check(ins.selected === ins.n && ins.unique && ins.tool === 'select' && !ins.pinned, 'the inserted part is selected, with fresh ids, and not pinned to the page');
await page.keyboard.press('Control+z');
check(await app(() => window._app.activeSketch().entities.length === 0 && window._app.project.layers.length === 1), 'one Undo removes the inserted part and its layer');
await page.keyboard.press('Control+o');
await page.waitForSelector('#account-modal.show .open-item');
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
await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
await page.click('#lib-detail [data-a="copy"]');
const copied = await page.evaluate(() => window.__copied);
check(/\/app\/\?view=[^&]+$/.test(copied || '') && /opens this sketch directly in the editor/.test(await page.textContent('#lib-detail .account-msg')), `Copy link copies the editor link (${(copied || '').replace(/^https?:\/\/[^/]+/, '')})`);
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
await page.waitForFunction(() => window._app?.project?.name === 'Shelf v2 (remix)');
check(await app(() => window._app.cloudLink === null && window._app.project.toJSON().sketches[0].entities.some(e => e.type === 'circle')), 'Remix: the sketch opens in the editor, not linked to anyone\'s account');
check(await app(() => { const r = window._app.project.remixedFrom; return !!r && r.name === 'Shelf v2' && /^p/.test(r.id) && /Remix of "Shelf v2"/.test(document.getElementById('status-hint').textContent); }),
  'Remix signed out: credited to the original (remixedFrom) and the status bar says so');
check(!/view=/.test(page.url()), 'view parameter cleaned');
// Library ▸ Insert into my sketch: a public sketch as a part in the open drawing.
const nBefore = await app(() => window._app.activeSketch().entities.length);
await page.waitForTimeout(900);                       // the copy is saved in this browser
await page.goto(base.replace('/app/', '/library/'));
await page.locator('.lib-card .card-title a', { hasText: /^Shelf v2$/ }).click();
await page.waitForSelector('#lib-detail [data-a="insert"]');
await page.click('#lib-detail [data-a="insert"]');
await page.waitForFunction((n) => window._app?.activeSketch().entities.length === 2 * n, nBefore);
check(!/insert=/.test(page.url()) && await app(() => window._app.project.layers.length >= 2 && window._app.project.name === 'Shelf v2 (remix)'),
  'library ▸ Insert into my sketch: added to the open drawing, at real size, URL cleaned');

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

// About page (the former landing): account menu when signed in, Sign in (and back) when signed out.
const home = base.replace('/app/', '/about/');
await page.goto(home);
await page.waitForSelector('#site-account .site-acc-btn');
await page.click('#site-account .site-acc-btn');
check(await app(() => { const m = document.querySelector('#site-account .site-acc-menu'); return !m.hidden && m.textContent.includes('other@example.com')
  && ['My sketches', 'Library', 'Open the editor', 'Sign out'].every(t => [...m.querySelectorAll('a, button')].some(i => i.textContent.trim() === t)); }),
  'landing page: avatar menu with My sketches, Library, Open the editor, Sign out');
await page.click('#site-account [data-a="signout"]');
await page.waitForSelector('#site-account .site-acc-signin');
check(await app(() => !localStorage.getItem('fake-sb:session')), 'landing page: Sign out signs out');
check(/back=%2Fabout%2F$/.test(await page.getAttribute('#site-account .site-acc-signin', 'href')), 'landing page: Sign in link comes back here');
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
await page.route(/stripe\.test/, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>checkout</title>' }));
await page.goto(base.replace('/app/', '/pricing/'));
await page.waitForSelector('.pr-cta[data-plan="pro"] [data-a="buy"]');
check((await page.textContent('[data-price]')) === '$29' && /2\.42/.test(await page.textContent('[data-sub]')) && !(await page.$('.pr-toggle')), 'pricing: yearly only, $29 ($2.42 a month), no monthly toggle');
check((await page.textContent('.pr-cta[data-plan="pro"] .btn')) === 'Get Pro', 'pricing: one Get Pro button');
check((await page.textContent('.pr-cta[data-plan="free"]')).includes('Your plan'), 'pricing: Free marked as your plan');
await page.click('.pr-cta[data-plan="pro"] [data-a="buy"]');
await page.waitForURL(/checkout\.stripe\.test\/c\/year\?user=u1/);
check(true, 'Get Pro opens the Stripe checkout for this user, yearly');

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
await page.waitForURL(/billing\.stripe\.test\/p/);
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
await page.emulateMedia({ colorScheme: 'dark' });
await app(() => localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'dark' })));
await page.reload();
await page.waitForSelector('.pr-card');
check(await app(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.querySelector('.pr-card')).backgroundColor !== 'rgb(255, 255, 255)'),
  'pricing follows the editor\'s dark theme, like every page');
await page.emulateMedia({ colorScheme: 'light' });
await app(() => localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })));
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
  await p2.goto(base.replace('/app/', '/about/'));
  await p2.waitForSelector('#site-account .site-acc-signin');
  check(fetched.length === 0 && await p2.evaluate(() => document.documentElement.scrollWidth <= 390), 'about page signed out: Sign in, nothing loaded from Supabase, fits a phone');
  await c2.close();
}

// Private sketches are Pro only (migration 0008), even where the database
// still has the 0007 rule (free private allowed): the free plan saves
// public, and a free sketch made private back then stays private, can be
// made public, but not private again.
{
  const c5 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await c5.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
  await c5.addInitScript(installFake);
  await c5.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.clear(); localStorage.setItem('fake-sb:free-private', '1'); } });
  const p5 = await c5.newPage();
  const errs5 = [];
  p5.on('pageerror', e => errs5.push(String(e)));
  await p5.goto(base.replace('/app/', '/pricing/'));
  await p5.waitForFunction(() => window._pricing && window._pricing.freePrivate === false);
  const priceText = await p5.evaluate(() => [...document.querySelectorAll('#pr-free li, #pr-pro li')].filter(li => !li.hidden).map(li => li.textContent.trim()).join(' | '));
  check(/Sketches are public/.test(priceText) && !/Private or public/.test(priceText) && /Private sketches/.test(priceText),
    'pricing: Free says sketches are public, Pro lists private sketches');
  await p5.goto(base);
  await p5.waitForFunction(() => window._app);
  const b5 = await p5.locator('#canvas').boundingBox();
  await p5.keyboard.press('r');
  await p5.mouse.click(b5.x + b5.width / 2 - 100, b5.y + b5.height / 2 - 60); await p5.mouse.click(b5.x + b5.width / 2 + 80, b5.y + b5.height / 2 + 50);
  await p5.keyboard.press('Escape');
  await p5.keyboard.press('Control+s');
  await p5.waitForSelector('#account-modal.show input[type=email]');
  await p5.fill('#account-modal input[type=email]', 'newbie@example.com');
  await p5.click('#account-modal button[type=submit]');
  await p5.waitForSelector('#account-modal input[name=code]');
  await p5.fill('#account-modal input[name=code]', '123456');
  await p5.click('#account-modal button[type=submit]');
  await p5.waitForSelector('#profile-modal input[name=username]');
  check(true, 'free: saving asks for a public username first (free sketches are public)');
  await p5.fill('#profile-modal input[name=username]', 'newbie_lab');
  await p5.waitForFunction(() => !document.querySelector('#profile-modal [type=submit]').disabled);
  await p5.click('#profile-modal [type=submit]');
  await p5.waitForSelector('#details-modal');
  check(!(await p5.$('#details-modal input[name=private]')) && /Free sketches are/.test(await p5.textContent('#details-modal')),
    'free: the save form has no Private box and says free sketches are public');
  await p5.fill('#details-name', 'Bracket idea');
  await p5.fill('#details-desc', 'A bracket for the lab bench, first idea.');
  await p5.click('#details-modal [data-a="ok"]');
  await p5.waitForFunction(() => !document.getElementById('details-modal'));
  const saved5 = await p5.evaluate(() => JSON.parse(localStorage.getItem('fake-sb:rows') || '[]'));
  check(saved5.length === 1 && saved5[0].visibility === 'public', 'free: the sketch is saved public');
  // A sketch made private while the free plan allowed it.
  await p5.evaluate(() => { const r = JSON.parse(localStorage.getItem('fake-sb:rows')); r[0].visibility = 'private'; localStorage.setItem('fake-sb:rows', JSON.stringify(r)); });
  await p5.goto(base + 'projects/');
  await p5.waitForSelector('.sketch-card .tag.private');
  await p5.locator('.sketch-card[data-id]').first().locator('.menu-btn').click();
  await p5.click('.card-menu [data-a="details"]');
  await p5.waitForSelector('#details-modal');
  check(await p5.isChecked('#details-modal input[name=private]') && /Kept private from before/.test(await p5.textContent('#details-modal')),
    'free, private from before: Edit details keeps Private ticked, with a note');
  await p5.fill('#details-desc', 'A bracket for the lab bench, second idea.');
  await p5.click('#details-modal [data-a="ok"]');
  await p5.waitForFunction(() => !document.getElementById('details-modal'));
  check((await p5.evaluate(() => JSON.parse(localStorage.getItem('fake-sb:rows'))[0].visibility)) === 'private', '…and saving the details doesn\'t publish it');
  await p5.locator('.sketch-card[data-id]').first().locator('.menu-btn').click();
  check(await p5.isVisible('.card-menu [data-a="public"]'), 'My sketches (free): a private sketch from before can be made public');
  await p5.click('.card-menu [data-a="public"]');
  await p5.waitForSelector('.sketch-card .tag.public');
  check((await p5.evaluate(() => JSON.parse(localStorage.getItem('fake-sb:rows'))[0].visibility)) === 'public', '…then the sketch is public');
  await p5.locator('.sketch-card[data-id]').first().locator('.menu-btn').click();
  check(await p5.isVisible('.card-menu [data-a="private-pro"]') && !(await p5.$('.card-menu [data-a="private"]')), '…and only Pro can make it private again ("Make private (Pro)")');
  check(errs5.length === 0, 'free plan, public only: no page errors' + (errs5.length ? ': ' + errs5.join(' | ') : ''));
  await c5.close();
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

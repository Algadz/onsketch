// Version history (History window) and remixes, against the in-page
// fake of supabase-js (tests/fake-supabase.mjs): versions kept on save,
// the free plan's last 3, Compare on the canvas, Restore (and Ctrl+Z),
// Copy as new sketch, named versions on Pro, a server without history,
// and a library remix credited to its original.
// Usage: node tests/history.e2e.mjs   (SHOT_DIR=… saves screenshots)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { installFake } from './fake-supabase.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;
const base = `${origin}/app/`;
const shots = process.env.SHOT_DIR;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
await ctx.addInitScript(installFake);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const app = (fn, arg) => page.evaluate(fn, arg);
const LS = (k) => app((k) => JSON.parse(localStorage.getItem(k) || '[]'), k);

// Signed in as u1 (@alba), with a version kept on every save (gap 0).
await page.goto(base);
await app(() => {
  const s = { user: { id: 'u1', email: 'me@example.com' } };
  localStorage.setItem('fake-sb:session', JSON.stringify(s));
  localStorage.setItem('sb-rwmzpzaqijgdfsjmpqbd-auth-token', JSON.stringify(s));
  localStorage.setItem('fake-sb:t:public_profiles', JSON.stringify([{ user_id: 'u1', username: 'alba' }, { user_id: 'u2', username: 'bob' }]));
  localStorage.setItem('fake-sb:version-gap', '0');
  localStorage.setItem('onsketch:guide', 'done'); localStorage.setItem('onsketch:tour', 'done');
});
await page.reload();
await page.waitForFunction(() => window._app?.cloudUser);
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

check(await page.isVisible('#menubar [data-window="history"]'), 'History button in the menu bar (Windows)');

// History of a drawing that isn't saved yet: asks to save.
await page.click('#menubar [data-window="history"]');
await page.waitForSelector('#history-body .hist-empty');
check((await page.textContent('#history-body')).includes('only in this browser'), 'unsaved drawing: History asks to save it first');

// Draw, save to the account.
await page.keyboard.press('r');
await page.mouse.click(cx - 120, cy - 60); await page.mouse.click(cx + 60, cy + 60);
await page.keyboard.press('Escape');
await page.fill('#project-name', 'Bracket');
await page.keyboard.press('Enter');
await page.click('#menubar [data-action="save"]');
await page.waitForSelector('#details-modal').catch(async (e) => { await page.screenshot({ path: (shots || '/tmp') + '/history-debug.png' }); console.log(await app(() => [document.getElementById('status-hint').textContent, window._app.activeSketch().entities.length, document.querySelector('.app-dialog')?.textContent])); throw e; });
await page.fill('#details-desc', 'A small steel bracket');
await page.click('#details-modal [data-a="ok"]');
await page.waitForFunction(() => window._app.cloudLink && !document.getElementById('details-modal'));
await page.waitForSelector('#history-body .hist-list');
check((await page.textContent('#history-body')).includes('No earlier versions yet'), 'saved: History lists no earlier versions yet');

/** Draws a line and sends the save at once. */
async function edit(i) {
  await page.keyboard.press('l');
  await page.mouse.click(cx - 200 + i * 30, cy + 120); await page.mouse.click(cx - 180 + i * 30, cy + 200);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await app(() => window._app._cloudPush());
  await page.waitForFunction(() => window._app.cloudLink && !window._app.cloudLink.dirty && window._app._cloudStatus === 'saved');
}
for (let i = 0; i < 5; i++) await edit(i);
const versions = (await LS('fake-sb:t:project_versions'));
check(versions.length === 3, `free plan: the server keeps the last 3 versions (${versions.length})`);
// Re-open to list them.
await page.click('#menubar [data-window="history"]');
await page.click('#menubar [data-window="history"]');
await page.waitForFunction(() => document.querySelectorAll('#history-body .hist-item[data-v]:not(.hist-now)').length === 3);
check(true, 'History lists 3 versions under "Now"');
check((await page.textContent('#history-body .hist-foot')).includes('last 3 versions'), 'free plan: footer says the last 3 versions, Pro keeps all');
check(await page.isVisible('#history-body .hist-save.pro-locked'), 'Save version… shows a Pro badge on the free plan');
await page.waitForFunction(() => document.querySelectorAll('#history-body canvas.hist-thumb.ready').length === 3);
check(true, 'each version has a thumbnail');

// Compare with the oldest.
const nowCount = await app(() => window._app.activeSketch().entities.length);
await page.locator('#history-body .hist-item[data-v]:not(.hist-now)').last().click();
await page.waitForSelector('#history-body .hist-changes');
const diff = await app(() => { const d = window._app._compare.diff; return { added: d.shapes.added.length, removed: d.shapes.removed.length, text: document.querySelector('#history-body .hist-changes').textContent }; });
check(diff.added === 3 && diff.removed === 0 && /Shapes: 3 added/.test(diff.text), `Compare: 3 lines added since the oldest kept version (${diff.text.trim()})`);
const px = await page.evaluate(({ x, y }) => {             // the overlay is drawn: a green pixel on the newest line
  const c = document.getElementById('canvas'), r = c.getBoundingClientRect(), dpr = c.width / r.width;
  const d = c.getContext('2d').getImageData(Math.round((x - r.left) * dpr) - 3, Math.round((y - r.top) * dpr) - 3, 7, 7).data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 120 && d[i] < 90 && d[i + 2] < 120) return true;
  return false;
}, { x: cx - 200 + 4 * 30 + 10, y: cy + 160 });
check(px, 'Compare: new shapes are drawn green on the canvas');
if (shots) await page.screenshot({ path: shots + '/history-compare.png' });
await page.keyboard.press('Escape');
await page.waitForFunction(() => !window._app._compare);
check(true, 'Escape stops comparing');

// Save version… on the free plan: the Pro prompt.
await page.click('#history-body [data-h="save-version"]');
await page.waitForSelector('.app-dialog');
check((await page.textContent('.app-dialog h3')) === 'Named versions is part of OnSketch Pro', 'Save version… on free: "part of OnSketch Pro"');
await page.keyboard.press('Escape');

// Restore the oldest; Ctrl+Z brings the drawing back.
await page.locator('#history-body .hist-item[data-v]:not(.hist-now)').last().click();
await page.waitForSelector('#history-body [data-h="restore"]');
await page.click('#history-body [data-h="restore"]');
await page.waitForSelector('.app-dialog').catch(async (e) => { await page.screenshot({ path: (shots || '/tmp') + '/history-debug.png' }); console.log(errors); throw e; });
await page.click('.app-dialog .btn.primary');
await page.waitForFunction((n) => window._app.activeSketch().entities.length === n - 3, nowCount);
const rows1 = await LS('fake-sb:rows');
check(rows1[0].data.sketches[0].entities.length === nowCount - 3 && rows1[0].name === 'Bracket', 'Restore: the old drawing is back, on the server too, title kept');
await page.waitForFunction(() => document.querySelector('#history-body')?.textContent.includes('Before a restore'));
check(true, 'Restore: the drawing before is kept as a version ("Before a restore")');
await page.click('#canvas', { position: { x: 5, y: 5 } });
await page.keyboard.press('Control+z');
await page.waitForFunction((n) => window._app.activeSketch().entities.length === n, nowCount);
check(true, 'Ctrl+Z after a restore brings the drawing back');

// Copy as new sketch.
await page.locator('#history-body .hist-item[data-v]:not(.hist-now)').first().click();
await page.waitForSelector('#history-body [data-h="copy"]');
const firstId = await app(() => window._app.cloudLink.id);
await page.click('#history-body [data-h="copy"]');
await page.waitForFunction((id) => window._app.cloudLink && window._app.cloudLink.id !== id, firstId);
const rows2 = await LS('fake-sb:rows');
check(rows2.length === 2 && /^Bracket \(/.test(await app(() => window._app.project.name)), `Copy as new sketch: a second sketch, opened (${await app(() => window._app.project.name)})`);
check((await page.textContent('#history-body')).includes('No earlier versions yet'), 'the copy starts its own history');

// OnSketch Pro: named versions.
await app(() => localStorage.setItem('fake-sb:t:account_plans', JSON.stringify([{ user_id: 'u1', plan: 'premium', status: 'active' }])));
await page.reload();
await page.waitForFunction(() => window._app?.cloudUser && window._app.cloudPlan?.plan === 'premium');
await page.waitForSelector('#history-body .hist-list');
check(!(await page.isVisible('#history-body .hist-save.pro-locked')), 'Pro: no Pro badge on Save version…');
await page.click('#history-body [data-h="save-version"]');
await page.waitForSelector('#history-body .hist-form');
await page.click('#history-body .hist-form button[type=submit]');
check((await page.textContent('#history-body .hist-form-msg')).includes('name'), 'Save version… needs a name');
await page.fill('#history-body .hist-form input[name=name]', 'First cut');
await page.fill('#history-body .hist-form textarea[name=note]', 'Holes at 20 mm');
await page.click('#history-body .hist-form button[type=submit]');
await page.waitForFunction(() => [...document.querySelectorAll('#history-body .hist-item.named b')].some(b => b.textContent.includes('First cut')));
const named = (await LS('fake-sb:t:project_versions')).find(v => v.kind === 'named');
check(named && named.name === 'First cut' && named.note === 'Holes at 20 mm', 'Pro: "Save version…" keeps a named version with its note');
check((await page.textContent('#history-body .hist-foot')).includes('whole history'), 'Pro: footer says the whole history is kept');
// Name an automatic version.
await edit(9);
await page.click('#menubar [data-window="history"]'); await page.click('#menubar [data-window="history"]');
await page.waitForFunction(() => document.querySelectorAll('#history-body .hist-item[data-v]:not(.hist-now)').length === 2);
await page.locator('#history-body .hist-item[data-v]:not(.hist-now):not(.named)').first().click();
await page.click('#history-body [data-h="name"]');
await page.fill('#history-body .hist-form input[name=name]', 'Before the slot');
await page.click('#history-body .hist-form button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('#history-body .hist-item.named').length === 2);
check(true, 'Pro: Name… turns an automatic version into a named one');
if (shots) await page.screenshot({ path: shots + '/history-pro.png' });

// A server without the history migration: said plainly.
await app(() => localStorage.setItem('fake-sb:no-history', '1'));
await page.click('#menubar [data-window="history"]'); await page.click('#menubar [data-window="history"]');
await page.waitForFunction(() => /isn't available/.test(document.querySelector('#history-body')?.textContent || ''));
check(true, 'without the server migration: "Version history isn\'t available on this server yet"');
await app(() => localStorage.removeItem('fake-sb:no-history'));

// Remix: @bob's public sketch, opened from the library, saved as mine.
await app(() => {
  const rows = JSON.parse(localStorage.getItem('fake-sb:rows'));
  const data = { ...rows[0].data, name: 'Hinge' };
  rows.push({ id: 'pbob', owner_id: 'u2', name: 'Hinge', description: 'A printable hinge, 3 parts', visibility: 'public', revision: 1,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', data });
  localStorage.setItem('fake-sb:rows', JSON.stringify(rows));
});
await page.goto(`${origin}/library/?s=pbob`);
await page.waitForSelector('#lib-detail a.btn.primary');
check((await page.textContent('#lib-detail a.btn.primary')).trim() === 'Remix', 'library: the main button is Remix');
await page.click('#lib-detail a.btn.primary');
await page.waitForFunction(() => window._app?.project?.name === 'Hinge (remix)');
check(await app(() => window._app.project.remixedFrom?.author === 'bob' && /Remix of "Hinge" by @bob/.test(document.getElementById('status-hint').textContent)),
  'Remix: opens as "Hinge (remix)", credited to @bob');
await page.keyboard.press('Control+s');
await page.waitForSelector('#details-modal');
check((await page.inputValue('#details-desc')) === 'Remix of "Hinge" by @bob.', 'saving a remix: the description starts with the credit');
await page.fill('#details-name', 'Hinge, 4 parts');
await page.uncheck('#details-modal input[name=private]');           // Pro: public, to share it in the library
await page.click('#details-modal [data-a="ok"]');
await page.waitForFunction(() => window._app.cloudLink && !document.getElementById('details-modal'));
const remix = (await LS('fake-sb:rows')).find(r => r.name === 'Hinge, 4 parts');
check(remix && remix.remixed_from === 'pbob', 'saved remix records remixed_from on the server');
await page.goto(`${origin}/library/`);
await page.waitForSelector('.lib-card');
const counts = await app(() => [...document.querySelectorAll('.lib-card')].map(c => [c.querySelector('.card-title').textContent, c.querySelector('.remix-count')?.textContent.trim() || '']));
check(counts.some(([t, n]) => t === 'Hinge' && n === '1') && counts.some(([t, n]) => t === 'Hinge, 4 parts' && n === ''), `library: the original shows 1 remix (${JSON.stringify(counts)})`);
await page.locator('.lib-card .card-title a', { hasText: 'Hinge, 4 parts' }).click();
await page.waitForSelector('#lib-detail .lib-remix-of');
check((await page.textContent('#lib-detail .lib-remix-of')).trim() === 'Remix of Hinge by @bob', 'remix detail: "Remix of Hinge by @bob"');
if (shots) await page.screenshot({ path: shots + '/library-remix.png' });
await page.click('#lib-detail .lib-remix-of [data-open]');
await page.waitForFunction(() => document.querySelector('#lib-detail h3')?.textContent === 'Hinge');
check((await page.textContent('#lib-detail')).includes('remixed 1 time'), 'the credit opens the original, which says "remixed 1 time"');

check(!errors.length, `no page errors ${errors.join(' | ')}`);
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall history checks passed');
process.exit(failed ? 1 : 0);

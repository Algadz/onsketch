// End-to-end test of copy / cut / paste (Ctrl+C / X / V and the menus) for
// texts, images and other ink, within the app, across tabs and from the system.
// Usage: node tests/clipboard.e2e.mjs [rootDir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

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
const port = server.address().port;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
await context.addInitScript(() => { try { localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); } catch { /* none */ } });
const errors = [];
const watch = (page) => {
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  page.on('console', m => { if (m.type() === 'error' && !/umami|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.route(/umami/, r => r.abort());
};
const page = await context.newPage();
watch(page);
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const S = (w, p = page) => p.evaluate((w) => { const a = window._app, s = a.view.worldToScreen(w), r = a.canvas.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, w);
const ink = (p = page) => p.evaluate(() => window._app.activeSketch().strokes.map(s => ({
  id: s.id, kind: s.kind, text: s.text, image: s.image, x: s.points[0].x, y: s.points[0].y, selected: !!s.selected, group: s.group || null,
})));
const settle = () => page.waitForTimeout(150);

// ---- A text: Ctrl+C, Ctrl+V, Ctrl+V ----
await page.keyboard.press('t');
await page.mouse.click(cx + 200, cy - 100);
await page.keyboard.type('Kitchen');
await page.keyboard.press('Enter');
await page.keyboard.press('s');
let items = await ink();
const t0 = items[0];
await page.mouse.click(...Object.values(await S({ x: t0.x + 1, y: t0.y - 1 })));
check((await ink())[0].selected, 'the text is selected');
await page.keyboard.press('Control+c');
await settle();
check(await page.evaluate(() => window._app.toolName === 'select'), 'Ctrl+C doesn\'t switch to the Circle tool');
await page.keyboard.press('Control+v');
await settle();
items = await ink();
check(items.length === 2 && items[1].text === 'Kitchen', 'Ctrl+V pastes a copy of the text');
check(items[1].selected && !items[0].selected, 'the copy is selected, the original isn\'t');
check(items[1].x > t0.x && items[1].y < t0.y && items[1].id !== t0.id, 'the copy lands down and to the right');
await page.keyboard.press('Control+v');
await settle();
items = await ink();
check(items.length === 3 && items[2].x > items[1].x, 'pasting again goes further');
check(await page.evaluate(() => navigator.clipboard.readText()) === 'Kitchen', 'other apps get the words as plain text');
await page.keyboard.press('Control+z');
check((await ink()).length === 2, 'a paste is one undo step');

// ---- Cut ----
await page.mouse.click(...Object.values(await S({ x: t0.x + 1, y: t0.y - 1 })));
await page.keyboard.press('Control+x');
await settle();
check((await ink()).length === 1, 'Ctrl+X removes the selected ink');
await page.keyboard.press('Control+v');
await settle();
check((await ink()).length === 2, 'and Ctrl+V puts it back');

// ---- An image: copy as PNG for other apps, paste here ----
const pngB64 = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 60; c.height = 40;
  const g = c.getContext('2d'); g.fillStyle = '#00aa00'; g.fillRect(0, 0, 30, 40);
  return c.toDataURL('image/png').split(',')[1];
});
const chooser = page.waitForEvent('filechooser');
await page.click('.fwin[data-win="sketch"] [data-import-image]');
await (await chooser).setFiles({ name: 'g.png', mimeType: 'image/png', buffer: Buffer.from(pngB64, 'base64') });
await page.waitForFunction(() => window._app.activeSketch().strokes.some(s => s.kind === 'image'));
await page.keyboard.press('Control+c');
await page.waitForTimeout(400);
const types = await page.evaluate(async () => (await navigator.clipboard.read())[0].types);
check(types.includes('image/png') && types.includes('text/html'), `a copied image goes on the clipboard as PNG too (${types.join(', ')})`);
await page.keyboard.press('Control+v');
await settle();
items = await ink();
const imgs = items.filter(i => i.kind === 'image');
check(imgs.length === 2 && imgs[0].image === imgs[1].image, 'Ctrl+V pastes the image (one stored picture)');

// ---- Another tab ----
const page2 = await context.newPage();
watch(page2);
await page2.goto(`http://localhost:${port}/app/`);
await page2.waitForFunction(() => window._app);
await page2.evaluate(() => { const a = window._app; a.project = new a.project.constructor(); a.project.addSketch('S'); a.refreshUI(); a.requestRender(); });
await page2.locator('#canvas').click({ position: { x: 700, y: 400 } });
await page2.keyboard.press('Control+v');
await page2.waitForTimeout(300);
const other = await ink(page2);
check(other.length === 1 && other[0].kind === 'image', 'ink copied in one tab pastes in another');
check(await page2.evaluate(() => { const it = window._app.activeSketch().strokes[0]; return !!window._app.project.toJSON().images?.[it.image]; }), 'with the picture\'s data');
await page2.close();

// ---- From other apps: plain text and an image ----
await page.evaluate(() => navigator.clipboard.writeText('Hello\nfrom the OS'));
const spot = { x: cx - 250, y: cy + 150 };
await page.mouse.move(spot.x, spot.y);
await page.keyboard.press('Control+v');
await settle();
items = await ink();
const os = items[items.length - 1];
check(os.kind === 'text' && os.text === 'Hello\nfrom the OS', 'plain text from another app becomes a text label');
const at = await page.evaluate(() => { const a = window._app, r = a.canvas.getBoundingClientRect(), it = a.activeSketch().strokes.at(-1);
  const s = a.view.worldToScreen(it.points[0]); return { x: s.x + r.left, y: s.y + r.top }; });
check(Math.abs(at.x - spot.x) < 120 && Math.abs(at.y - spot.y) < 40, 'it lands under the cursor');
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
}, pngB64);
await page.keyboard.press('Control+v');
await page.waitForFunction(() => window._app.activeSketch().strokes.filter(s => s.kind === 'image').length === 3);
check(true, 'an image from another app is imported');

// ---- Fields keep their own paste ----
await page.evaluate(() => navigator.clipboard.writeText('typed'));
const n0 = (await ink()).length;
await page.evaluate(() => { const a = window._app; a.clearStrokeSelection(); const t = a.activeSketch().strokes.find(s => s.kind === 'text'); t.selected = true; a.refreshUI(); });
await page.focus('[data-ink-k="text"]');
await page.keyboard.press('Control+v');
await settle();
check((await ink()).length === n0, 'Ctrl+V in a Properties field pastes into the field, not the canvas');
await page.mouse.click(cx + 300, cy + 250);

// ---- Menus ----
items = await ink();
const tt = items.find(i => i.text === 'Kitchen');
const tp = await S({ x: tt.x + 1, y: tt.y - 1 });
await page.mouse.click(tp.x, tp.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="copy"]');
check(await page.isVisible('#context-menu [data-action="cut"]'), 'right-click ink offers Copy and Cut');
await page.click('#context-menu [data-action="copy"]');
await page.waitForTimeout(300);
await page.mouse.click(box.x + box.width - 60, box.y + box.height - 60, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="paste"]');
const before = (await ink()).length;
await page.click('#context-menu [data-action="paste"]');
await page.waitForFunction((n) => window._app.activeSketch().strokes.length === n + 1, before);
check((await ink()).at(-1).text === 'Kitchen', 'right-click empty canvas → Paste');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

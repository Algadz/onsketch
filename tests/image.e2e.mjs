// End-to-end test of imported images (file picker, size limit, drop, paste,
// transparency, resize / turn, link to a line, undo, reload) in headless Chromium.
// Usage: node tests/image.e2e.mjs [rootDir] [screenshotPath]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const shot = process.argv[3] || null;
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
page.on('console', m => { if (m.type() === 'error' && !/umami|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.route(/umami/, r => r.abort());
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

await page.addInitScript(() => { try { localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); } catch { /* none */ } });
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const S = (w) => page.evaluate((w) => { const a = window._app, s = a.view.worldToScreen(w), r = a.canvas.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, w);
const images = () => page.evaluate(() => window._app.activeSketch().strokes.filter(s => s.kind === 'image').map(s => ({
  image: s.image, pts: s.points.map(p => ({ x: p.x, y: p.y })), selected: !!s.selected, link: s.link ? s.link.to : null,
})));
const size = (it) => ({ w: Math.hypot(it.pts[1].x - it.pts[0].x, it.pts[1].y - it.pts[0].y), h: Math.hypot(it.pts[2].x - it.pts[0].x, it.pts[2].y - it.pts[0].y) });
const center = (it) => ({ x: (it.pts[1].x + it.pts[2].x) / 2, y: (it.pts[1].y + it.pts[2].y) / 2 });
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
// Canvas pixel (CSS px relative to the page) as [r, g, b, a].
const pixel = (p) => page.evaluate(({ x, y }) => {
  const a = window._app, r = a.canvas.getBoundingClientRect(), d = a.renderer.dpr;
  a._render();
  return [...a.canvas.getContext('2d').getImageData(Math.round((x - r.left) * d), Math.round((y - r.top) * d), 1, 1).data];
}, p);

// A 200 × 100 PNG: left half opaque red, right half fully transparent.
const pngB64 = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 100;
  const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 100, 100);
  return c.toDataURL('image/png').split(',')[1];
});
const png = Buffer.from(pngB64, 'base64');

// A line to link to.
await page.keyboard.press('l');
await page.mouse.click(cx - 300, cy + 200);
await page.mouse.click(cx + 300, cy + 200);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
const lineId = await page.evaluate(() => window._app.activeSketch().entities.find(e => e.constructor.kind === 'line').id);

// ---- Import with the Sketch window button ----
check(await page.isVisible('.fwin[data-win="sketch"] [data-import-image]'), 'Image… is in the Sketch window');
let chooser = page.waitForEvent('filechooser');
await page.click('.fwin[data-win="sketch"] [data-import-image]');
await (await chooser).setFiles({ name: 'half.png', mimeType: 'image/png', buffer: png });
await page.waitForFunction(() => window._app.activeSketch().strokes.some(s => s.kind === 'image'));
let [img] = await images();
check(img.selected && await page.evaluate(() => window._app.toolName === 'select'), 'the image comes in selected, with the Select tool');
let sz = size(img);
check(near(sz.w / sz.h, 2), `keeps its proportions (${sz.w.toFixed(1)} × ${sz.h.toFixed(1)})`);
const vc = await page.evaluate(() => { const v = window._app.view; return v.screenToWorld({ x: v.cssW / 2, y: v.cssH / 2 }); });
check(near(center(img).x, vc.x) && near(center(img).y, vc.y), 'placed in the middle of the view');
check(await page.evaluate(() => /image/.test(document.getElementById('sb-body')?.textContent || document.body.textContent)), 'Properties shows the image');

// transparency: red on the left, the canvas shows through on the right
await page.evaluate(() => { for (const s of window._app.activeSketch().strokes) s.selected = false; window._app.requestRender(); });
const quarter = (fx) => S({ x: img.pts[0].x + (img.pts[1].x - img.pts[0].x) * fx, y: center(img).y });
const left = await pixel(await quarter(0.25)), right = await pixel(await quarter(0.75));
check(left[0] > 200 && left[1] < 60 && left[2] < 60, `opaque half is drawn (${left})`);
check(!(right[0] > 200 && right[1] < 60), `transparent half shows the canvas (${right})`);

// ---- Too large ----
const viaKey = await page.evaluate(() => {
  const a = window._app, orig = a.openImagePicker; let n = 0;
  a.openImagePicker = () => { n++; };
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
  a.openImagePicker = orig;
  return n;
});
check(viaKey === 1, 'I opens the image picker');
chooser = page.waitForEvent('filechooser');
await page.click('.fwin[data-win="sketch"] [data-import-image]');
await (await chooser).setFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.alloc(3.2 * 1024 * 1024)]) });
await page.waitForSelector('.app-dialog');
check(/less than 3 MB/.test(await page.textContent('.app-dialog')), 'a file over 3 MB is refused with a message');
await page.keyboard.press('Enter');
await page.waitForSelector('.app-dialog', { state: 'detached' });
check((await images()).length === 1, 'nothing was added');

// Pictures together are capped per sketch: 2.0 MB is accepted, another 1.5 MB is not.
const fat = Buffer.from(await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1100; c.height = 1100;
  const g = c.getContext('2d'), d = g.createImageData(1100, 1100);
  for (let i = 0; i < d.data.length; i++) d.data[i] = (Math.random() * 256) | 0;
  g.putImageData(d, 0, 0);
  return c.toDataURL('image/png').split(',')[1];
}), 'base64');
const pick = async (name, buffer) => {
  const ch = page.waitForEvent('filechooser');
  await page.click('.fwin[data-win="sketch"] [data-import-image]');
  await (await ch).setFiles({ name, mimeType: 'image/png', buffer });
};
await pick('a.png', fat.subarray(0, 2.0 * 1024 * 1024));
await page.waitForFunction(() => window._app.activeSketch().strokes.filter(s => s.kind === 'image').length === 2);
await pick('b.png', fat.subarray(0, 1.5 * 1024 * 1024));
await page.waitForSelector('.app-dialog');
check(/Too many images/.test(await page.textContent('.app-dialog')), 'a picture that takes the sketch past its total is refused');
await page.keyboard.press('Enter');
await page.waitForSelector('.app-dialog', { state: 'detached' });
check((await images()).length === 2, 'it was not added');
await page.evaluate(() => window._app.undo());
check((await images()).length === 1, 'undo removes an imported picture');

// ---- Resize with the corner handle ----
await page.evaluate(() => { const a = window._app; a.activeSketch().strokes.find(s => s.kind === 'image').selected = true; a.refreshUI(); a.requestRender(); });
const handles = await page.evaluate(() => {
  const a = window._app, b = a._inkBoxScreen(a.selectedStrokes()), r = a.canvas.getBoundingClientRect();
  return { br: { x: b.corners[2].x + r.left, y: b.corners[2].y + r.top }, turn: { x: b.turn.x + r.left, y: b.turn.y + r.top } };
});
const before = size(img);
const tl = await S(img.pts[0]);
await page.mouse.move(handles.br.x, handles.br.y);
await page.mouse.down();
await page.mouse.move(handles.br.x + (handles.br.x - tl.x) * 0.25, handles.br.y + (handles.br.y - tl.y) * 0.25, { steps: 6 });
await page.mouse.move(handles.br.x + (handles.br.x - tl.x) * 0.5, handles.br.y + (handles.br.y - tl.y) * 0.5, { steps: 6 });
await page.mouse.up();
[img] = await images();
sz = size(img);
check(sz.w > before.w * 1.4 && near(sz.w / sz.h, 2, 1e-2), `corner handle resizes, keeping proportions (${(sz.w / before.w * 100).toFixed(0)} %)`);

// ---- Turn ----
const turned = await page.evaluate(() => {
  const a = window._app, b = a._inkBoxScreen(a.selectedStrokes()), r = a.canvas.getBoundingClientRect();
  return { x: b.turn.x + r.left, y: b.turn.y + r.top, cx: (b.corners[0].x + b.corners[2].x) / 2 + r.left, cy: (b.corners[0].y + b.corners[2].y) / 2 + r.top };
});
await page.mouse.move(turned.x, turned.y);
await page.mouse.down();
const rad = turned.cy - turned.y;
await page.mouse.move(turned.cx + rad * Math.sin(Math.PI / 8), turned.cy - rad * Math.cos(Math.PI / 8), { steps: 5 });
await page.mouse.move(turned.cx + rad, turned.cy, { steps: 5 });
await page.mouse.up();
[img] = await images();
const ang = Math.atan2(img.pts[1].y - img.pts[0].y, img.pts[1].x - img.pts[0].x) * 180 / Math.PI;
check(Math.abs(ang + 90) < 3, `turn handle turns the picture (${ang.toFixed(1)}°)`);
check(near(size(img).w, sz.w, 1e-2), 'turning keeps its size');

// ---- Link to the line: it scales and turns with it ----
const mid = await S(center(img));
await page.mouse.click(mid.x, mid.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="link"]');
await page.click('#context-menu [data-action="link"]');
const lineMid = await page.evaluate((id) => { const l = window._app.activeSketch().entities.find(e => e.id === id); return { x: (l.p1.x + l.p2.x) / 2 + 30, y: l.p1.y }; }, lineId);
const lm = await S(lineMid);
await page.mouse.click(lm.x, lm.y);
[img] = await images();
check(img.link === lineId, 'Link to a shape… links the image to the line');
const linked = size(img);
await page.evaluate((id) => {
  const a = window._app, l = a.activeSketch().entities.find(e => e.id === id);
  const mx = (l.p1.x + l.p2.x) / 2;
  l.p2.x = mx + (l.p2.x - mx) * 2; l.p1.x = mx + (l.p1.x - mx) * 2;      // twice as long
  a.commit();
}, lineId);
[img] = await images();
check(near(size(img).w, linked.w * 2, 1e-2), `doubling the line doubles the picture (${(size(img).w / linked.w).toFixed(2)}×)`);
await page.evaluate((id) => {
  const a = window._app, l = a.activeSketch().entities.find(e => e.id === id);
  const s = a.activeSketch();
  s.constraints = s.constraints.filter(c => !c.refs().some(r => r === l.id || r === l.p1.id || r === l.p2.id));  // free the line (it snapped horizontal)
  const mx = (l.p1.x + l.p2.x) / 2, half = (l.p2.x - l.p1.x) / 2;
  l.p1.x = mx; l.p1.y -= half; l.p2.x = mx; l.p2.y += half;               // turned 90° about its middle
  a.commit();
}, lineId);
[img] = await images();
const ang2 = Math.atan2(img.pts[1].y - img.pts[0].y, img.pts[1].x - img.pts[0].x) * 180 / Math.PI;
check(Math.abs(ang2 - 0) < 1 || Math.abs(Math.abs(ang2) - 180) < 1, `turning the line turns the picture (${ang2.toFixed(1)}°)`);

// ---- Undo keeps the picture's data ----
await page.keyboard.press('Control+z');
[img] = await images();
check(near(size(img).w, linked.w * 2, 1e-2), 'undo steps back through the link changes');
check(await page.evaluate(() => window._app.undoStack.every(j => !j.includes('data:image'))), 'undo snapshots don\'t carry the image data');

// ---- Drop and paste ----
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
  const c = window._app.canvas, r = c.getBoundingClientRect();
  c.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.left + 100, clientY: r.top + 100, bubbles: true, cancelable: true }));
}, pngB64);
await page.waitForFunction(() => window._app.activeSketch().strokes.filter(s => s.kind === 'image').length === 2);
const dropped = (await images())[1];
const dropAt = await page.evaluate(() => window._app.view.screenToWorld({ x: 100, y: 100 }));
check(near(center(dropped).x, dropAt.x) && near(center(dropped).y, dropAt.y), 'a dropped image lands where it is dropped');
check(dropped.image === img.image, 'the same picture is stored once');
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, pngB64);
await page.waitForFunction(() => window._app.activeSketch().strokes.filter(s => s.kind === 'image').length === 3);
check(true, 'a pasted image is added');

// ---- Saved with the drawing ----
await page.evaluate(() => window._app._writeLocal());
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sketchcad:last')));
check(saved && saved.images && Object.keys(saved.images).length === 1, 'the browser copy holds the picture once');
if (shot) await page.screenshot({ path: shot });
await page.reload();
await page.waitForFunction(() => window._app);
const after = await images();
check(after.length === 3 && after[0].link === lineId, 'reload brings the images back, still linked');
const shown = await page.evaluate(() => new Promise(r => setTimeout(() => {
  const a = window._app, it = a.activeSketch().strokes.find(s => s.kind === 'image');
  const xs = it.points.map(p => p.x).concat(it.points[1].x + it.points[2].x - it.points[0].x);
  const ys = it.points.map(p => p.y).concat(it.points[1].y + it.points[2].y - it.points[0].y);
  a.view.fitTo({ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }, 80);
  const [p0, p1, p2] = it.points;
  const q = a.view.worldToScreen({ x: p0.x + (p1.x - p0.x) * 0.25 + (p2.x - p0.x) * 0.5, y: p0.y + (p1.y - p0.y) * 0.25 + (p2.y - p0.y) * 0.5 });
  a._render();
  const d = a.renderer.dpr; r([...a.canvas.getContext('2d').getImageData(Math.round(q.x * d), Math.round(q.y * d), 1, 1).data]);
}, 300)));
check(shown[0] > 200 && shown[1] < 80, `the reloaded picture is drawn (${shown})`);

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

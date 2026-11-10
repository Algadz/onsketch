// End-to-end test of arrows, and resizing / turning ink, driven like a user
// (keyboard, drags on handles, right-click menus) in headless Chromium.
// Usage: node tests/arrow.e2e.mjs [rootDir] [screenshotPath]
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
const items = () => page.evaluate(() => window._app.activeSketch().strokes.map(s => ({
  kind: s.kind, pts: s.points.map(p => [p.x, p.y]), width: s.width, size: s.size, angle: s.angle || 0,
  at: s.at || null, tips: s.tips || 'end', head: s.head || 'filled', dash: !!s.dash, selected: !!s.selected,
})));
const drag = async (from, to, opts = {}) => {
  await page.mouse.move(from.x, from.y);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up('Shift');
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// A circle (the "hole") to point at, dimensioned so it can change.
await page.keyboard.press('c');
await page.mouse.click(cx + 150, cy);
await page.mouse.click(cx + 190, cy);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
const hole = await page.evaluate(() => { const c = window._app.activeSketch().entities.find(e => e.constructor.kind === 'circle'); return { id: c.id, x: c.center.x, y: c.center.y, r: c.r }; });

// ---- Arrow tool ----
await page.keyboard.press('w');
check(await page.evaluate(() => window._app.toolName === 'arrow'), 'W selects the Arrow tool');
check(await page.isVisible('.fwin[data-win="sketch"] [data-tool="arrow"]'), 'Arrow is in the Sketch window');
check(await page.isVisible('.fwin[data-win="sketch"] [data-arrow="head:open"]'), 'the Sketch window shows Ends / Head / Line for arrows');
// a click without a drag draws nothing
await page.mouse.click(cx - 200, cy - 150);
check((await items()).length === 0, 'a click without a drag draws no arrow');
// drag from free space onto the circle's rim (left quadrant snaps)
const rimLeft = await S({ x: hole.x - hole.r, y: hole.y });
await drag({ x: cx - 200, y: cy - 120 }, { x: rimLeft.x - 2, y: rimLeft.y + 1 });
let a = (await items())[0];
check(a && a.kind === 'arrow', 'dragging draws an arrow');
check(a && near(a.pts[1][0], hole.x - hole.r) && near(a.pts[1][1], hole.y), 'the tip snaps onto the circle');
check(a && a.at && a.at[1] && a.at[1].to === hole.id && !a.at[0], `the tip is attached to the circle (${JSON.stringify(a?.at)})`);

// the circle grows and moves: the tip follows, the tail stays
const tail = a.pts[0];
await page.evaluate((id) => { const app = window._app, c = app.activeSketch().entities.find(e => e.id === id); c.r *= 1.5; c.center.x += 10; app.commit(); }, hole.id);
a = (await items())[0];
check(near(a.pts[1][0], hole.x + 10 - hole.r * 1.5) && near(a.pts[0][0], tail[0]) && near(a.pts[0][1], tail[1]), 'attached tip follows the circle; tail stays');
await page.evaluate(() => window._app.undo());
a = (await items())[0];
check(near(a.pts[1][0], hole.x - hole.r), 'undo puts the tip back');

// style from the Sketch window applies to the next arrow; Shift keeps 15° steps
await page.click('.fwin[data-win="sketch"] [data-arrow="tips:both"]');
await page.click('.fwin[data-win="sketch"] [data-arrow="head:open"]');
await page.click('.fwin[data-win="sketch"] [data-arrow="dash:true"]');
await drag({ x: cx - 250, y: cy + 150 }, { x: cx - 100, y: cy + 160 }, { shift: true });
const b = (await items())[1];
check(b && b.tips === 'both' && b.head === 'open' && b.dash, `new arrow takes Ends / Head / Line (${b?.tips}, ${b?.head}, ${b?.dash})`);
check(b && near(b.pts[0][1], b.pts[1][1]), 'Shift keeps the arrow at 15° steps (horizontal here)');
await page.click('.fwin[data-win="sketch"] [data-arrow="tips:end"]');
await page.click('.fwin[data-win="sketch"] [data-arrow="head:filled"]');
await page.click('.fwin[data-win="sketch"] [data-arrow="dash:false"]');

// ---- Select an arrow: end handles re-aim it ----
await page.keyboard.press('s');
const mid = await S({ x: (a.pts[0][0] + a.pts[1][0]) / 2, y: (a.pts[0][1] + a.pts[1][1]) / 2 });
await page.mouse.click(mid.x, mid.y);
check((await items())[0].selected, 'clicking an arrow selects it');
const tipS = await S({ x: a.pts[1][0], y: a.pts[1][1] });
await drag(tipS, { x: tipS.x - 40, y: tipS.y - 60 });
a = (await items())[0];
check(!a.at, 'dragging the tip off the circle detaches it');
const centerS = await S({ x: hole.x, y: hole.y });
const tipNow = await S({ x: a.pts[1][0], y: a.pts[1][1] });
await drag(tipNow, { x: centerS.x + 1, y: centerS.y - 1 });
a = (await items())[0];
check(a.at && a.at[1] && near(a.pts[1][0], hole.x) && near(a.pts[1][1], hole.y), 'dropping the tip on the centre re-attaches it there');
check(await page.isVisible('#sel-body [data-ink-arrow="head:dot"]') && /attached/.test(await page.textContent('#sel-body')), 'Properties shows arrow style and what it is attached to');
await page.click('#sel-body [data-ink-arrow="head:dot"]');
check((await items())[0].head === 'dot', 'Properties changes the head');

// ---- Resize and turn a mixed selection ----
await page.keyboard.press('t');
await page.mouse.click(cx - 120, cy + 260);
await page.waitForSelector('textarea.text-edit');
await page.keyboard.type('Label');
await page.keyboard.press('Enter');
await page.keyboard.press('n');
await drag({ x: cx - 120, y: cy + 300 }, { x: cx - 40, y: cy + 320 });
await page.keyboard.press('s');
await page.evaluate(() => { const app = window._app; app.clearSelection(); for (const s of app.activeSketch().strokes) if (s.kind !== 'arrow') s.selected = true; app.refreshUI(); app.requestRender(); });
const before = await items();
const txt0 = before.find(i => i.kind === 'text'), pen0 = before.find(i => i.kind === 'pen');
const tbox = await page.evaluate(() => { const app = window._app, r = app.canvas.getBoundingClientRect(); const b = app._inkBoxScreen(app.selectedStrokes()); return { c: b.corners.map(p => ({ x: p.x + r.left, y: p.y + r.top })), turn: { x: b.turn.x + r.left, y: b.turn.y + r.top } }; });
check(await page.evaluate(() => !!window._app._inkTransformTarget()), 'selected ink shows a transform box');
// corner: bottom-right, out by half the box diagonal → 150 % (proportional)
const br = tbox.c[2], tl = tbox.c[0];
await page.mouse.move(br.x, br.y);
check(await page.evaluate(() => getComputedStyle(window._app.canvas).cursor) === 'nwse-resize', 'corner handle shows a resize cursor');
await drag(br, { x: br.x + (br.x - tl.x) * 0.5, y: br.y + (br.y - tl.y) * 0.5 });
let after = await items();
let txt1 = after.find(i => i.kind === 'text'), pen1 = after.find(i => i.kind === 'pen');
const k = txt1.size / txt0.size;
check(k > 1.3 && k < 1.6 && near(pen1.width / pen0.width, k, 1e-6), `corner drag scales text size and stroke width together (×${k.toFixed(3)})`);
// Esc cancels a drag in progress
const turnNow = await page.evaluate(() => { const app = window._app, r = app.canvas.getBoundingClientRect(); const b = app._inkBoxScreen(app.selectedStrokes()); return { x: b.turn.x + r.left, y: b.turn.y + r.top }; });
await page.mouse.move(turnNow.x, turnNow.y);
await page.mouse.down();
await page.mouse.move(turnNow.x + 80, turnNow.y + 40, { steps: 5 });
await page.keyboard.press('Escape');
await page.mouse.up();
after = await items();
check(after.find(i => i.kind === 'text').angle === 0, 'Esc cancels a turn in progress');
// turn with Shift: snaps to 15° steps
const center = await page.evaluate(() => { const app = window._app, r = app.canvas.getBoundingClientRect(); const b = app._inkBoxScreen(app.selectedStrokes()); return { x: (b.corners[0].x + b.corners[2].x) / 2 + r.left, y: (b.corners[0].y + b.corners[2].y) / 2 + r.top }; });
const R = Math.hypot(turnNow.x - center.x, turnNow.y - center.y);
await drag(turnNow, { x: center.x + R * Math.sin(Math.PI / 4 + 0.05), y: center.y - R * Math.cos(Math.PI / 4 + 0.05) }, { shift: true });
txt1 = (await items()).find(i => i.kind === 'text');
check(near(txt1.angle, -Math.PI / 4, 1e-9), `turn handle with Shift turns by 45° clockwise (${(txt1.angle * 180 / Math.PI).toFixed(2)}°)`);
// right-click: Rotate 90°, Flip
const textMid = await page.evaluate(() => { const app = window._app, t = app.activeSketch().strokes.find(s => s.kind === 'text'); const b = app._inkBoxScreen([t]); const r = app.canvas.getBoundingClientRect(); return { x: (b.corners[0].x + b.corners[2].x) / 2 + r.left, y: (b.corners[0].y + b.corners[2].y) / 2 + r.top }; });
await page.mouse.click(textMid.x, textMid.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="rotate90"]');
check(/Flip horizontal/.test(await page.textContent('#context-menu')), 'right-click offers Rotate 90° and Flip');
await page.click('#context-menu [data-action="rotate90"]');
txt1 = (await items()).find(i => i.kind === 'text');
check(near(txt1.angle, -3 * Math.PI / 4, 1e-9), 'Rotate 90° turns clockwise by a quarter turn');
await page.mouse.click(textMid.x, textMid.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="flipH"]');
const penBefore = (await items()).find(i => i.kind === 'pen').pts;
await page.click('#context-menu [data-action="flipH"]');
const penAfter = (await items()).find(i => i.kind === 'pen').pts;
check(!near(penAfter[0][0], penBefore[0][0]) && near(penAfter[0][1], penBefore[0][1]), 'Flip horizontal mirrors the strokes');
// one undo step per gesture
const n = await page.evaluate(() => window._app.undoStack.length);
await page.evaluate(() => window._app.undo());
check(await page.evaluate(() => window._app.undoStack.length) === n - 1, 'each transform is one undo step');
if (shot) {
  await page.evaluate(() => window._app.redo());
  await page.evaluate(() => { const app = window._app; app.clearSelection(); for (const s of app.activeSketch().strokes) if (s.kind !== 'arrow') s.selected = true; app.refreshUI(); app.requestRender(); });
  await page.screenshot({ path: shot });
}

// Reload keeps arrows (with attachments) and turned texts.
await page.evaluate(() => window._app._writeLocal());
const saved = await items();
await page.reload();
await page.waitForFunction(() => window._app);
const back = await items();
check(back.length === saved.length && JSON.stringify(back.map(i => [i.kind, i.at, i.head, Math.round(i.angle * 1e6)])) === JSON.stringify(saved.map(i => [i.kind, i.at, i.head, Math.round(i.angle * 1e6)])), 'arrows, attachments and turned texts survive a reload');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

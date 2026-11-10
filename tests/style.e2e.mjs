// End-to-end test of restyling arrows and texts (draw first, refine after;
// older ones stay editable) and of the touch tap-through guard.
// Usage: node tests/style.e2e.mjs [rootDir]
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
  id: s.id, kind: s.kind, color: s.color, tips: s.tips || 'end', head: s.head || 'filled', dash: !!s.dash,
  width: s.width, size: s.size, bold: !!s.bold, box: s.box ? (s.box.border ? 'outline' : 'box') : 'none', text: s.text, selected: !!s.selected,
})));
const drag = async (from, to) => {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 }); await page.mouse.up();
};
const RED = '#d63a3a', BLUE = '#1f7ad6', GREEN = '#14946b';
const swatch = (c) => page.click(`#colors-body .palette .sw[data-c="${c}"]`);
await page.evaluate(() => { const a = window._app; a.snapEnabled = false; a.view.zoom = 1; a.view.panX = 0; a.view.panY = 0; a.requestRender(); });

// ---- Arrow: draw, then restyle the one just drawn ----
await page.click('#sketch-body [data-tool="arrow"]');
const a1from = { x: cx - 150, y: cy - 200 }, a1to = { x: cx + 50, y: cy - 200 };
await drag(a1from, a1to);
let it = await items();
check(it.length === 1 && it[0].kind === 'arrow' && it[0].selected, 'a new arrow is selected right away');
await swatch(RED);
await page.click('#sketch-body [data-arrow="dash:true"]');
it = await items();
check(it[0].color === RED && it[0].dash, 'colour and line picked after drawing restyle the new arrow');
check(await page.evaluate(() => window._app.pen.arrowDash === true), '…and become the style of the next arrow');

// ---- A second arrow: the first is let go ----
await drag({ x: cx - 150, y: cy - 100 }, { x: cx + 50, y: cy - 100 });
await swatch(BLUE);
it = await items();
const [A, B] = it;
check(!A.selected && B.selected && A.color === RED && B.color === BLUE && B.dash, 'drawing the next arrow deselects the first; restyling hits only the new one');

// ---- An older arrow is still editable: click it with the Arrow tool ----
await page.mouse.click((a1from.x + a1to.x) / 2, a1from.y);
it = await items();
check(it[0].selected && !it[1].selected, 'a click (no drag) on an arrow selects it, with no new arrow');
check(await page.$eval('#sketch-body [data-arrow="dash:true"]', b => b.classList.contains('on')), 'the Sketch window shows the selected arrow\'s style');
await page.click('#sketch-body [data-arrow="tips:both"]');
it = await items();
check(it[0].tips === 'both' && it[1].tips === 'end', 'the older arrow takes the new ends; the other one is unchanged');
const u = await page.evaluate(() => window._app.undoStack.length);
await page.click('#sketch-body [data-arrow="head:open"]');
check(await page.evaluate(() => window._app.undoStack.length) === u + 1, 'each restyle is one undo step');

// ---- Esc deselects, Delete removes ----
await page.keyboard.press('Escape');
it = await items();
check(it.every(i => !i.selected) && await page.evaluate(() => window._app.toolName) === 'arrow', 'Esc deselects and keeps the Arrow tool');
await swatch(GREEN);
it = await items();
check(it[0].color === RED && it[1].color === BLUE, 'with nothing selected, a colour only sets the next arrow');
await page.mouse.click((a1from.x + a1to.x) / 2, a1from.y);
await page.keyboard.press('Delete');
it = await items();
check(it.length === 1 && it[0].id === B.id, 'Delete removes the selected arrow');

// ---- Text: restyle while typing, then after ----
await page.click('#sketch-body [data-tool="text"]');
await page.mouse.click(cx - 100, cy + 20);
await page.keyboard.type('Hello');
await page.click('#sketch-body [data-bold="1"]');
check(await page.evaluate(() => document.activeElement?.classList.contains('text-edit')), 'pressing Bold while typing keeps the text box open');
await page.keyboard.type(' world');
await swatch(RED);
await page.keyboard.press('Enter');
it = await items();
let T = it.find(i => i.kind === 'text');
check(T && T.text === 'Hello world' && T.bold && T.color === RED, 'Bold and colour picked while typing apply to the text being typed');
check(T.selected, 'the finished text stays selected');
await page.click('#sketch-body [data-boxmode="outline"]');
const sizeBefore = T.size;
await page.$eval('#sketch-body input[type=range]', (r) => { r.value = String(+r.value + 10); r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
T = (await items()).find(i => i.kind === 'text');
check(T.box === 'outline' && T.size > sizeBefore, 'box and size changed after finishing restyle the text');
// an older text: a click with the Text tool opens it, and the style controls apply to it
await page.mouse.click(cx - 100, cy + 160);
await page.keyboard.type('Second');
await page.keyboard.press('Enter');
const tb = await page.evaluate((id) => { const a = window._app, t = a.activeSketch().strokes.find(s => s.id === id), b = a._inkBoxScreen([t]), r = a.canvas.getBoundingClientRect(); return { x: (b.corners[0].x + b.corners[2].x) / 2 + r.left, y: (b.corners[0].y + b.corners[2].y) / 2 + r.top }; }, T.id);
await page.keyboard.press('Escape');
await page.mouse.click(tb.x, tb.y);
await page.click('#sketch-body [data-bold="0"]');
await page.keyboard.press('Enter');
it = await items();
check(!it.find(i => i.id === T.id).bold && it.find(i => i.text === 'Second').bold, 'an older text, clicked with the Text tool, takes the new style; the other keeps its own');

// ---- Select tool: selected arrows and texts are restyled by the same controls ----
await page.click('#tools-body [data-tool="select"]');
const bMid = await S(await page.evaluate((id) => { const s = window._app.activeSketch().strokes.find(x => x.id === id); return { x: (s.points[0].x + s.points[1].x) / 2, y: s.points[0].y }; }, B.id));
await page.mouse.click(bMid.x, bMid.y);
check(await page.$('#optbar [data-opt-arrow="tips:both"]') !== null, 'with an arrow selected, the options bar shows its style controls');
await swatch(GREEN);
await page.click('#optbar [data-opt-arrow="dash:false"]');
const b2 = (await items()).find(i => i.id === B.id);
check(b2.color === GREEN && !b2.dash, 'with Select, the colour and line controls restyle the selected arrow');

// ---- Tap-through guard: the tap that shows a control can't press it ----
await page.evaluate(() => { const a = window._app; a.touchUI = true; document.documentElement.classList.add('touch-ui'); a.refreshUI(); });
check(await page.$eval('#fab-delete', b => !b.hidden), 'touch: the Delete button shows for a selection');
const ghost = await page.evaluate(() => {
  const canvas = window._app.canvas, fab = document.getElementById('fab-delete');
  canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  fab.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  return window._app.activeSketch().strokes.length;
});
check(ghost === (await items()).length && (await items()).some(i => i.id === B.id), 'a click from a tap that started on the canvas does not press Delete');
await page.click('#fab-delete');
check(!(await items()).some(i => i.id === B.id), 'a real press on Delete deletes');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

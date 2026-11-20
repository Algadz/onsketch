// End-to-end test: dimensions switch between driving and driven (Properties,
// the Dimensions rows, the right-click menu), refused when that would
// over-define the sketch; the line weight field reads "px"/"mm" in lowercase
// and is changed by dragging on it (Blender-style).
//
// Usage: node tests/driven.e2e.mjs [rootDir]
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
page.route(/umami/, r => r.abort());
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
await page.goto(`http://localhost:${port}/app/`);
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
await page.evaluate(() => { const a = window._app; for (const w of ['colors', 'tools', 'layers', 'equations', 'sketch']) a.windows.toggle(w, false); a.windows.toggle('props', true); a.refreshUI(); });

// A line from a fixed point, horizontal, 100 long (driving); a second line
// at an angle, with a driven angle dimension and a driven X distance.
const load = () => page.evaluate(() => {
  const a = window._app, P = (id, x, y) => ({ type: 'point', id, x, y });
  a.project = a.project.constructor.fromJSON({ version: 5, units: 'mm', activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }],
    sketches: [{ id: 's', name: 'S', entities: [
      { type: 'line', id: 'a', p1: P('p', 0, 0), p2: P('q', 100, 0) },
      { type: 'line', id: 'b', p1: P('r', 0, 0), p2: P('t', 40, 30) }],
    constraints: [
      { id: 'f', kind: 'fix', pointId: 'p', x: 0, y: 0 },
      { id: 'cc', kind: 'coincident', p1: 'p', p2: 'r' },
      { id: 'h', kind: 'horizontal', lineId: 'a', p1: 'p', p2: 'q' },
      { id: 'd1', kind: 'distance', p1: 'p', p2: 'q', value: 100 },
      { id: 'dx', kind: 'distance', p1: 'p', p2: 'q', value: 100, axis: 'x', driven: true },
      { id: 'ang', kind: 'angle', l1: { a: 'p', b: 'q' }, l2: { a: 'r', b: 't' }, value: 0.6435, driven: true }] }] });
  a._afterStateSwap(); a.view.zoom = 4; a.view.panX = 0; a.view.panY = 0; a.solveAndRender?.(); a._render();
});
const C = (id) => page.evaluate((id) => { const c = window._app.activeSketch().constraints.find(k => k.id === id); return c ? { driven: !!c.driven, value: c.value } : null; }, id);
const select = (id) => page.evaluate((id) => { const a = window._app; a.clearSelection(); a.setSelected(a.activeSketch().constraints.find(k => k.id === id), true); a.refreshUI(); }, id);

await load();
// ---- Properties: Driving | Driven on an angle dimension ----
await select('ang');
check(await page.isVisible('#sel-body [data-driven-seg]'), 'Properties shows Driving | Driven for an angle dimension');
check(await page.getAttribute('#sel-body [data-driven="1"]', 'class') === 'on', 'the driven angle shows Driven');
// it measures as the shape moves
await page.evaluate(() => { const a = window._app, t = a.activeSketch().entities[1].p2; t.x = 0; t.y = 50; a.refreshDrivenDimensions(); });
let ang = await C('ang');
check(Math.abs(ang.value - Math.PI / 2) < 1e-6, `a driven angle re-measures the shapes (${(ang.value * 180 / Math.PI).toFixed(2)}°)`);
await page.click('#sel-body [data-driven="0"]');
ang = await C('ang');
check(!ang.driven, 'clicking Driving makes the angle drive the shapes');
await page.evaluate(() => { const a = window._app; a.activeSketch().constraints.find(k => k.id === 'ang').value = Math.PI / 4; a.solveAndRender ? a.solveAndRender() : a.commit(); });
const t = await page.evaluate(() => { const p = window._app.activeSketch().entities[1].p2; return Math.atan2(p.y, p.x) * 180 / Math.PI; });
check(Math.abs(t - 45) < 1e-3, `as a driving dimension, 45° turns the line (${t.toFixed(3)}°)`);
// back to driven from the Dimensions row button of the line
await page.click('#sel-body [data-driven="1"]');
check((await C('ang')).driven, 'clicking Driven makes it a reference again');
const undo = await page.evaluate(() => { const a = window._app; a.undo(); return !!a.activeSketch().constraints.find(k => k.id === 'ang').driven; });
check(!undo, 'one undo step restores driving');

// ---- Refused when it would over-define ----
await load();
await select('dx');
await page.click('#sel-body [data-driven="0"]');
const dx = await C('dx');
const hint = await page.textContent('#status-hint');
check(dx.driven && /over-define/.test(hint), `an X distance on a fully defined line stays driven, with a note ("${hint.slice(0, 60)}…")`);

// ---- Dimensions list rows: the ( ) toggle ----
await page.evaluate(() => { const a = window._app; a.clearSelection(); a.setSelected(a.activeSketch().entities[0], true); a.refreshUI(); });
const rowBtn = '#sel-body .dim-row[data-cid="d1"] [data-drv]';
check(await page.isVisible(rowBtn), 'each dimension row of a line has a driven toggle');
await page.click(rowBtn);
check((await C('d1')).driven, 'the row toggle makes the length driven');
check(await page.getAttribute('#sel-body .dim-row[data-cid="d1"] [data-drv]', 'aria-pressed') === 'true', 'and shows it pressed');
await page.click('#sel-body .dim-row[data-cid="d1"] [data-drv]');
check(!(await C('d1')).driven, 'clicking again makes it driving');

// ---- Right-click a dimension label: Make driven / Make driving ----
// (without the X distance, whose label sits on the length's)
await page.evaluate(() => { const a = window._app, s = a.activeSketch(); s.constraints = s.constraints.filter(k => k.id !== 'dx'); a.clearSelection(); a.commit(); a.refreshUI(); a._render(); });
const r = await page.evaluate(() => { const a = window._app, r = a.renderer.lastDimRects.find(x => x.constraint.id === 'd1'), b = a.canvas.getBoundingClientRect(); return r && { x: b.left + r.x + r.w / 2, y: b.top + r.y + r.h / 2 }; });
check(!!r, 'the length label is on screen');
if (r) {
  await page.mouse.click(r.x, r.y, { button: 'right' });
  check(await page.isVisible('#context-menu [data-action="driven"]'), 'right-clicking a driving dimension offers Make driven');
  await page.click('#context-menu [data-action="driven"]');
  check((await C('d1')).driven, 'Make driven makes it a reference');
  await page.evaluate(() => window._app._render());
  await page.mouse.click(r.x, r.y, { button: 'right' });
  check(await page.isVisible('#context-menu [data-action="driving"]'), 'and on a driven one, Make driving');
  await page.click('#context-menu [data-action="driving"]');
  check(!(await C('d1')).driven, 'Make driving makes it drive again');
}

// ---- Line weight: lowercase unit, drag to change ----
await page.evaluate(() => { const a = window._app; a.clearSelection(); a.refreshUI(); });
const unitTxt = await page.evaluate(() => getComputedStyle(document.querySelector('#sel-body .size-opt .opt-val') || document.querySelector('#sel-body .size-opt')).textTransform);
check(unitTxt === 'none', `the size field's unit isn't capitalised (text-transform: ${unitTxt})`);
await page.evaluate(() => { const a = window._app; a.windows.toggle('sketch', true); a.setTool('pen'); a.refreshUI(); });
const penOpt = await page.innerText('#sketch-body .size-opt');
check(/\bmm\b/.test(penOpt) && !/Mm/.test(penOpt), `the pen size reads "mm" in lowercase ("${penOpt.replace(/\s+/g, ' ').trim()}")`);
await page.evaluate(() => { const a = window._app; a.setTool('select'); a.windows.toggle('sketch', false); a.clearSelection(); a.refreshUI(); });
const F = '#sel-body input[data-size="linePx"]';
const fb = await page.locator(F).boundingBox();
const w0 = await page.evaluate(() => window._app.project.sizes.linePx);
await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
await page.mouse.down();
await page.mouse.move(fb.x + fb.width / 2 + 60, fb.y + fb.height / 2, { steps: 6 });
const live = await page.evaluate(() => window._app.project.sizes.linePx);
await page.mouse.up();
const w1 = await page.evaluate(() => window._app.project.sizes.linePx);
check(Math.abs(live - 2 * w0) < 0.06 && w1 === live, `dragging right 60 px doubles the line weight (${w0} → ${w1} px)`);
check(await page.evaluate(() => document.activeElement?.dataset?.size !== 'linePx'), 'a drag does not open the field for typing');
const w1u = await page.evaluate(() => { const a = window._app; a.undo(); return a.project.sizes.linePx; });
check(w1u === w0, 'one undo step for the whole drag');
// Esc during a drag puts it back
const fb2 = await page.locator(F).boundingBox();
await page.mouse.move(fb2.x + fb2.width / 2, fb2.y + fb2.height / 2);
await page.mouse.down();
await page.mouse.move(fb2.x + fb2.width / 2 - 80, fb2.y + fb2.height / 2, { steps: 6 });
await page.keyboard.press('Escape');
await page.mouse.up();
check(await page.evaluate(() => window._app.project.sizes.linePx) === w0, 'Esc during a drag restores the weight');
// a click without moving opens the field for typing
const fb3 = await page.locator(F).boundingBox();
await page.mouse.click(fb3.x + fb3.width / 2, fb3.y + fb3.height / 2);
check(await page.evaluate(() => document.activeElement?.dataset?.size === 'linePx'), 'a click without dragging opens the field for typing');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

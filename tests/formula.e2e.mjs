// End-to-end test of writing equations: clicking a dimension label (or a
// shape) inserts its name in the value box, the Equations window and
// Properties; and the orbital construction driven by a variable.
// Usage: node tests/formula.e2e.mjs [rootDir]
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
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const P = (id, x, y) => ({ type: 'point', id, x, y });

// The "orbital sketch" construction: Earth, an orbit sized by a variable,
// a line from the orbit, tangent to it, sized by an equation.
await page.evaluate((proj) => {
  const a = window._app;
  a.project = a.project.constructor.fromJSON(proj);
  a._afterStateSwap();
  a.view.zoom = 12; a.view.panX = 0; a.view.panY = 0;
  a.commit({ diagnostics: 'sync' }); a.setTool('select');
  for (const w of ['colors', 'tools', 'sketch', 'layers']) a.windows.toggle(w, false);
  a.windows.toggle('equations', true); a.windows.toggle('props', true);
  a.refreshUI();
}, { version: 3, activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }], variables: [{ name: 'orbit', expr: '22400' }],
  sketches: [{ id: 's', name: 'S', entities: [
    { type: 'circle', id: 'earth', center: P('o', 0, 0), r: 6.3 },
    { type: 'circle', id: 'orb', center: P('o2', 0, 0), r: 11.2 },
    { type: 'line', id: 'v', p1: P('p', -5.83, 9.56), p2: P('q', -9.39, 7.30) },
  ], constraints: [
    { id: 'f', kind: 'fix', pointId: 'o', x: 0, y: 0 },
    { id: 'co', kind: 'coincident', p1: 'o2', p2: 'o' },
    { id: 'on', kind: 'pointOnCircle', pointId: 'p', circleId: 'orb', centerId: 'o2' },
    { id: 't', kind: 'tangent', l: { a: 'p', b: 'q' }, circleId: 'orb', centerId: 'o2' },
    { id: 'd1', kind: 'radius', circleId: 'earth', value: 6.3, isDiameter: true, name: 'D1', expr: '12.6', labelAngle: -0.8, labelDist: 9 },
    { id: 'd2', kind: 'radius', circleId: 'orb', value: 11.2, isDiameter: true, name: 'D2', expr: 'orbit/1000', labelAngle: 0.4, labelDist: 15 },
    { id: 'd3', kind: 'distance', p1: 'p', p2: 'q', value: 4.0, name: 'D3', expr: 'sqrt(360000/orbit)' },
  ] }] });
const state = () => page.evaluate(() => document.getElementById('status-state').textContent);
check(!/Over/.test(await state()), `the orbital sketch loads solved (${await state()})`);

// change the variable in the Equations window
for (const v of ['20300', '42000', '7000']) {
  const inp = page.locator('#equations-body input[data-k="var-expr"]').first();
  await inp.fill(v);
  await inp.press('Enter');
  await page.waitForTimeout(100);
  const g = await page.evaluate(() => {
    const s = window._app.activeSketch(), orb = s.entities.find(e => e.id === 'orb'), l = s.entities.find(e => e.id === 'v');
    const dot = (l.p1.x - orb.center.x) * (l.p2.x - l.p1.x) + (l.p1.y - orb.center.y) * (l.p2.y - l.p1.y);
    return { r: orb.r, len: Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y), dot };
  });
  const st = await state();
  check(!/Over/.test(st) && Math.abs(g.r - +v / 2000) < 1e-6 && Math.abs(g.len - Math.sqrt(360000 / +v)) < 1e-6 && Math.abs(g.dot) < 1e-6,
    `orbit = ${v}: ${st}, orbit Ø ${(g.r * 2).toFixed(2)}, line ${g.len.toFixed(3)}, still tangent`);
}

const dimCenter = (name) => page.evaluate(async (name) => {
  const a = window._app; a.requestRender();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = a.renderer.lastDimRects.find(r => r.constraint.name === name), c = a.canvas.getBoundingClientRect();
  return r && { x: c.left + r.x + r.w / 2, y: c.top + r.y + r.h / 2 };
}, name);

// ---- 1. The value box on the canvas ----
await page.evaluate(() => { const a = window._app; a.editDimValue(a.activeSketch().constraints.find(c => c.name === 'D3')); });
await page.waitForSelector('#workspace > input.dim-input');
await page.locator('#workspace > input.dim-input').fill('=');
const d1 = await dimCenter('D1');
await page.mouse.move(d1.x, d1.y);
check(await page.evaluate(() => window._app.canvas.style.cursor) === 'copy' && /insert D1/.test(await page.textContent('#status-hint')), 'hovering a dimension shows a copy cursor and "insert D1"');
await page.mouse.click(d1.x, d1.y);
check(await page.locator('#workspace > input.dim-input').inputValue() === '=D1', 'clicking dimension D1 inserts =D1 in the value box');
const d2 = await dimCenter('D2');
await page.mouse.click(d2.x, d2.y);
check(await page.locator('#workspace > input.dim-input').inputValue() === '=D1 + D2', 'a second click adds + D2 at the caret');
check(await page.evaluate(() => document.activeElement?.classList.contains('dim-input')), 'the box keeps the focus');
await page.keyboard.press('Escape');

// ---- 2. The Equations window ----
const d3expr = page.locator('#equations-body input[data-k="dim-expr"]').nth(2);
await d3expr.click();
await d3expr.fill('=sqrt(360000/orbit) * ');
await d3expr.press('End');
await page.mouse.click(d1.x, d1.y);
check(await d3expr.inputValue() === '=sqrt(360000/orbit) * D1', `in the Equations window, clicking D1 inserts it at the caret (${await d3expr.inputValue()})`);
check(await page.evaluate(() => document.activeElement?.dataset.k === 'dim-expr'), 'the field keeps the focus (nothing applied yet)');
await page.keyboard.press('Escape');
await d3expr.fill('=sqrt(360000/orbit)');
await d3expr.press('Enter');

// a variable takes a bare name (no =)
const varExpr = page.locator('#equations-body input[data-k="var-expr"]').first();
await varExpr.click();
await varExpr.fill('20000 + ');
await varExpr.press('End');
await page.mouse.click(d1.x, d1.y);
check(await varExpr.inputValue() === '20000 + D1', `in a variable, the name goes in as is (${await varExpr.inputValue()})`);
await varExpr.fill('20300');
await varExpr.press('Enter');

// ---- 3. Properties: a dimension field of the selection ----
await page.evaluate(() => { const a = window._app; a.clearSelection(); a.activeSketch().entities.find(e => e.id === 'v').selected = true; a.refreshUI(); });
const field = page.locator('#sel-body input[data-dim-edit]').first();
await field.click();
await field.press('End');
await page.mouse.click(d1.x, d1.y);
const pv = await field.inputValue();
check(/D1$/.test(pv) && pv.startsWith('='), `in Properties, clicking D1 inserts it (${pv})`);
await field.fill('=D1 / 2');
await field.press('Enter');
const len = await page.evaluate(() => { const l = window._app.activeSketch().entities.find(e => e.id === 'v'); return Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y); });
check(Math.abs(len - 6.3) < 1e-6, `and Enter applies it (line = D1 / 2 = ${len.toFixed(3)})`);

// clicking a shape still works
await page.evaluate(() => { const a = window._app; a.editDimValue(a.activeSketch().constraints.find(c => c.name === 'D3')); });
await page.waitForSelector('#workspace > input.dim-input');
await page.locator('#workspace > input.dim-input').fill('=');
const rim = await page.evaluate(() => { const a = window._app, c = a.canvas.getBoundingClientRect(), e = a.activeSketch().entities.find(e => e.id === 'earth'); const s = a.view.worldToScreen({ x: e.center.x, y: e.center.y - e.r }); return { x: c.left + s.x, y: c.top + s.y }; });
await page.mouse.click(rim.x, rim.y);
check(await page.locator('#workspace > input.dim-input').inputValue() === '=D1', 'clicking the circle itself still inserts its dimension (D1)');
await page.keyboard.press('Escape');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

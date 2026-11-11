// End-to-end test of relations and dimensions between layers: picking
// another layer's shapes, solving linked layers as one, hiding a layer.
// Usage: node tests/layers.e2e.mjs [rootDir]
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
const box = await page.locator('#canvas').boundingBox();
const P = (id, x, y) => ({ type: 'point', id, x, y });

// Base layer: a fully defined horizontal line A. Work layer (active): a
// free line B above it. A third, unrelated layer with line C.
await page.evaluate((proj) => {
  const a = window._app;
  a.project = a.project.constructor.fromJSON(proj);
  a._afterStateSwap();
  a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0;
  a.commit({ diagnostics: 'sync' }); a.setTool('select');
  for (const w of ['colors', 'tools', 'sketch', 'equations']) a.windows.toggle(w, false);
  a.refreshUI();
}, { version: 3, activeLayerId: 'work', layers: [{ id: 'base', name: 'Base' }, { id: 'work', name: 'Work' }, { id: 'far', name: 'Far' }],
  sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'A', layerId: 'base', p1: P('a1', -30, 0), p2: P('a2', 30, 0) },
    { type: 'line', id: 'B', layerId: 'work', p1: P('b1', -20, 15), p2: P('b2', 25, 15) },
    { type: 'line', id: 'C', layerId: 'far', p1: P('c1', -30, -40), p2: P('c2', 30, -40) },
  ], constraints: [
    { id: 'fa', kind: 'fix', pointId: 'a1', x: -30, y: 0, layerId: 'base' },
    { id: 'fb', kind: 'fix', pointId: 'a2', x: 30, y: 0, layerId: 'base' },
    { id: 'hb', kind: 'horizontal', lineId: 'B', p1: 'b1', p2: 'b2', layerId: 'work' },
  ] }] });
const toA = (g, x, y) => { const [x1, y1, x2, y2] = g.A; const dx = x2 - x1, dy = y2 - y1; return Math.abs(dx * (y - y1) - dy * (x - x1)) / Math.hypot(dx, dy); };
const midA = (g) => [(g.A[0] + g.A[2]) / 2, (g.A[1] + g.A[3]) / 2];
const scr = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
const click = async (x, y, opts) => { const q = await scr(x, y); await page.mouse.move(q.x, q.y, { steps: 2 }); await page.mouse.click(q.x, q.y, opts); };
const geo = () => page.evaluate(() => {
  const s = window._app.activeSketch(), g = (id) => s.entities.find(e => e.id === id);
  const L = (id) => { const l = g(id); return [l.p1.x, l.p1.y, l.p2.x, l.p2.y].map(v => +v.toFixed(4)); };
  return { A: L('A'), B: L('B'), C: L('C'), sel: s.entities.filter(e => e.selected).map(e => e.id), active: window._app.project.activeLayerId };
});

// ---- Pick another layer's shape ----
await click(0, 0);
let g = await geo();
check(g.sel.includes('A') && g.active === 'work', 'clicking a shape on another layer selects it (the layer stays)');
check(/On layer "Base"/.test(await page.textContent('#sb-body').catch(() => '') || await page.textContent('body')), 'Properties says it is on layer "Base"');
check(/layer "Base"/.test(await page.textContent('#status-hint')), 'the status bar says how to use it');

// dragging it doesn't move it
const a0 = (await geo()).A;
{ const q = await scr(10, 0); await page.mouse.move(q.x, q.y); await page.mouse.down(); await page.mouse.move(q.x + 40, q.y + 30, { steps: 5 }); await page.mouse.up(); }
check(JSON.stringify((await geo()).A) === JSON.stringify(a0), 'dragging another layer\'s shape doesn\'t move it');

// Delete doesn't remove it
await click(0, 0);
await page.keyboard.press('Delete');
check(await page.evaluate(() => window._app.activeSketch().entities.some(e => e.id === 'A')), 'Delete leaves another layer\'s shape alone');

// ---- A relation between layers, from Properties ----
await click(0, 0);
await page.keyboard.down('Control');
await click(0, 15);
await page.keyboard.up('Control');
g = await geo();
check(g.sel.includes('A') && g.sel.includes('B'), 'Ctrl-click adds the active layer\'s line to the selection');
await page.waitForSelector('[data-rel="equal"], [data-rel="equalLength"]');
await page.click('[data-rel="equal"], [data-rel="equalLength"]');
g = await geo();
const lenB = Math.hypot(g.B[2] - g.B[0], g.B[3] - g.B[1]);
check(Math.abs(lenB - 60) < 1e-3, `Equal between layers makes B as long as A (${lenB.toFixed(3)})`);
check(JSON.stringify(g.A) === JSON.stringify(a0), 'A (fixed) did not move');
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
check(await page.evaluate(() => !!document.querySelector('.layer-tag.cross')), 'the relation is tagged "Base ↔ Work" in Properties');
check(await page.evaluate(() => document.querySelector('#layer-list .lyr-row[data-layer-id="base"]').classList.contains('linked')
  && !document.querySelector('#layer-list .lyr-row[data-layer-id="far"]').classList.contains('linked')), 'the Layers window marks Base as linked to Work, not Far');

// ---- Smart Dimension between layers ----
await page.keyboard.press('Escape');
await page.evaluate(() => window._app.clearSelection());
await page.keyboard.press('d');
await click(0, 0);
await click(0, 15);
{ const q = await scr(40, 7); await page.mouse.move(q.x, q.y, { steps: 3 }); await page.mouse.click(q.x, q.y); }
await page.waitForSelector('.dim-input');
await page.fill('.dim-input', '20');
await page.keyboard.press('Enter');
g = await geo();
check(Math.abs(g.B[1] - 20) < 1e-6 && Math.abs(g.B[3] - 20) < 1e-6, `a dimension from Work to Base's line sets the distance (B at y=${g.B[1]})`);
const dim = await page.evaluate(() => { const a = window._app, c = a.activeSketch().constraints.find(k => k.kind === 'offsetDistance'); return { id: c.id, state: a.constraintLayerState(c), driven: !!c.driven }; });
check(dim.state === 'active' && !dim.driven, 'it is a driving dimension, editable from Work');

// ---- Linked layers solve as one: free A, fix B, change the dimension ----
await page.evaluate(() => {
  const a = window._app, s = a.activeSketch();
  s.constraints = s.constraints.filter(c => c.kind !== 'fix');
  for (const p of s.entities.flatMap(e => e.children())) p.fixed = false;
  a.commit({ diagnostics: 'sync' });
});
await page.evaluate((id) => {
  const a = window._app, c = a.activeSketch().constraints.find(k => k.id === id);
  a._setOffsetDistanceValue(c, 32); a.commit({ diagnostics: 'sync' });
}, dim.id);
g = await geo();
const gap = toA(g, g.B[0], g.B[1]);
check(Math.abs(gap - 32) < 1e-3, `changing the value keeps the layers 32 apart (gap ${gap.toFixed(4)})`);
check(JSON.stringify(g.C) === JSON.stringify([-30, -40, 30, -40]), 'the unrelated layer never moved');

// ---- Hiding a layer hides its shapes and the dimension, not the link ----
await page.evaluate(() => { const a = window._app; a.project.layer('base').visible = false; a.commit({ diagnostics: 'sync' }); a.refreshUI(); });
const hidden = await page.evaluate((id) => { const a = window._app, c = a.activeSketch().constraints.find(k => k.id === id); a._render(); return a.constraintLayerState(c); }, dim.id);
check(hidden === 'hidden', 'hiding Base hides the dimension between the layers');
await page.evaluate((id) => {
  const a = window._app, c = a.activeSketch().constraints.find(k => k.id === id);
  a._setOffsetDistanceValue(c, 12); a.commit({ diagnostics: 'sync' });
}, dim.id);
g = await geo();
check(Math.abs(toA(g, g.B[0], g.B[1]) - 12) < 1e-3, `the hidden layer still follows the dimension (constraints kept) (${toA(g, g.B[0], g.B[1]).toFixed(4)})`);
check(await page.evaluate(([x, y]) => window._app.hitTestAcrossLayers({ x, y })?.id !== 'A', midA(g)), 'a hidden layer can\'t be picked');
await page.evaluate(() => { const a = window._app; a.project.layer('base').visible = true; a.commit({ diagnostics: 'sync' }); a.refreshUI(); });

// ---- Double-click and right-click another layer's shape ----
await page.keyboard.press('s');
g = await geo();
await click(...midA(g), { button: 'right' });
await page.waitForSelector('#context-menu [data-action="edit-layer"]');
check(/Edit layer "Base"/.test(await page.textContent('#context-menu')), 'right-click offers Edit layer "Base"');
await page.keyboard.press('Escape');
{ const q = await scr(...midA(g)); await page.mouse.dblclick(q.x, q.y); }
check((await geo()).active === 'base', 'double-click another layer\'s shape to edit its layer');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

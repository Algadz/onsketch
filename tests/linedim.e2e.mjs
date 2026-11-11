// End-to-end test of Smart Dimension between two parallel lines (free lines,
// a rectangle's sides, slanted lines), driven like a user in headless Chromium.
// Usage: node tests/linedim.e2e.mjs [rootDir]
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
const load = (entities, constraints = []) => page.evaluate(([entities, constraints]) => {
  const a = window._app;
  a.project = a.project.constructor.fromJSON({ version: 3, activeLayerId: 'la', layers: [{ id: 'la', name: 'A' }], sketches: [{ id: 's', name: 'S', entities, constraints }] });
  a._afterStateSwap();
  a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.setTool('smartdim');
  for (const w of ['props', 'colors', 'tools', 'layers', 'sketch', 'equations']) a.windows.toggle(w, false);
}, [entities, constraints]);
const scr = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
const click = async (x, y) => { const q = await scr(x, y); await page.mouse.move(q.x, q.y, { steps: 2 }); await page.mouse.click(q.x, q.y); };
const dimension = async (picks, place, value) => {
  for (const [x, y] of picks) await click(x, y);
  const q = await scr(...place); await page.mouse.move(q.x, q.y, { steps: 3 });
  const preview = await page.evaluate(() => { const p = window._app.tool.preview; return p ? { kind: p.kind, value: p.value, lines: !!p.l2 } : null; });
  await page.mouse.click(q.x, q.y);
  await page.waitForSelector('.dim-input');
  await page.fill('.dim-input', String(value));
  await page.keyboard.press('Enter');
  return preview;
};
const lineDist = (aId, bId) => page.evaluate(([aId, bId]) => {
  const s = window._app.activeSketch(), A = s.entities.find(e => e.id === aId), B = s.entities.find(e => e.id === bId);
  const dx = A.p2.x - A.p1.x, dy = A.p2.y - A.p1.y, L = Math.hypot(dx, dy);
  const d = (p) => Math.abs(dx * (p.y - A.p1.y) - dy * (p.x - A.p1.x)) / L;
  return [d(B.p1), d(B.p2)];
}, [aId, bId]);
const dims = () => page.evaluate(() => window._app.activeSketch().constraints.filter(c => c.value != null && c.kind !== 'fix')
  .map(c => ({ kind: c.kind, value: c.value, driven: !!c.driven, pairs: c.pairs ? c.pairs.length : 0, name: c.name || null })));

// ---- Two free parallel lines ----
await load([
  { type: 'line', id: 'A', p1: P('a1', -30, 0), p2: P('a2', 30, 0) },
  { type: 'line', id: 'B', p1: P('b1', -20, 15), p2: P('b2', 25, 15) },
], [{ id: 'fx', kind: 'fix', pointId: 'a1', x: -30, y: 0 }, { id: 'fx2', kind: 'fix', pointId: 'a2', x: 30, y: 0 }]);
const pv = await dimension([[0, 0], [0, 15]], [40, 7], 30);
check(pv && pv.lines && Math.abs(pv.value - 15) < 1e-6, `picking two parallel lines previews their distance (${JSON.stringify(pv)})`);
let d = await dims();
check(d.length === 1 && d[0].kind === 'offsetDistance' && !d[0].driven && d[0].value === 30, `a driving line-to-line dimension is made (${JSON.stringify(d)})`);
let [e1, e2] = await lineDist('A', 'B');
check(Math.abs(e1 - 30) < 1e-6 && Math.abs(e2 - 30) < 1e-6, `both ends of the line move to 30 (${e1.toFixed(4)}, ${e2.toFixed(4)})`);
await page.evaluate(() => { const a = window._app, c = a.activeSketch().constraints.find(k => k.kind === 'offsetDistance'); a._setOffsetDistanceValue(c, 12); a.commit({ diagnostics: 'sync' }); });
[e1, e2] = await lineDist('A', 'B');
check(Math.abs(e1 - 12) < 1e-6 && Math.abs(e2 - 12) < 1e-6, 'changing the value moves the line, still parallel');
const back = await page.evaluate(() => { const a = window._app; return JSON.parse(JSON.stringify(a.project.toJSON())).sketches[0].constraints.some(c => c.kind === 'offsetDistance'); });
check(back, 'saved with the drawing');

// ---- A rectangle: top and bottom are already horizontal ----
await load([
  { type: 'line', id: 'T', p1: P('r1', -20, 10), p2: P('r2', 20, 10) },
  { type: 'line', id: 'R', p1: P('r2', 20, 10), p2: P('r3', 20, -10) },
  { type: 'line', id: 'Bo', p1: P('r3', 20, -10), p2: P('r4', -20, -10) },
  { type: 'line', id: 'Le', p1: P('r4', -20, -10), p2: P('r1', -20, 10) },
], [
  { id: 'h1', kind: 'horizontal', lineId: 'T', p1: 'r1', p2: 'r2' },
  { id: 'h2', kind: 'horizontal', lineId: 'Bo', p1: 'r3', p2: 'r4' },
  { id: 'v1', kind: 'vertical', lineId: 'R', p1: 'r2', p2: 'r3' },
  { id: 'v2', kind: 'vertical', lineId: 'Le', p1: 'r4', p2: 'r1' },
  { id: 'fr', kind: 'fix', pointId: 'r4', x: -20, y: -10 },
]);
await dimension([[0, -10], [0, 10]], [30, 0], 35);
d = await dims();
check(d.length === 1 && d[0].kind === 'offsetDistance' && !d[0].driven && d[0].pairs === 1, `between a rectangle's sides it drives, on one end (the sides are already parallel) (${JSON.stringify(d)})`);
const h = await page.evaluate(() => { const s = window._app.activeSketch(), T = s.entities.find(e => e.id === 'T'), B = s.entities.find(e => e.id === 'Bo'); return [T.p1.y - B.p1.y, T.p2.y - B.p2.y]; });
check(Math.abs(h[0] - 35) < 1e-6 && Math.abs(h[1] - 35) < 1e-6, `the rectangle is now 35 tall (${h.map(v => v.toFixed(4))})`);
await page.evaluate(() => window._app.solveAndRender());
const state = await page.evaluate(() => document.getElementById('status-state')?.textContent || '');
check(!/over/i.test(state), `the sketch is not over-defined (${state})`);

// ---- Already fully defined: the extra dimension is driven (grey) ----
await page.evaluate(() => window._app.setTool('smartdim'));
await dimension([[0, -10], [0, 25]], [-30, 5], 50);
d = await dims();
check(d.length === 2 && d[1].driven, `a second distance between the same sides is driven, not over-defining (${JSON.stringify(d)})`);

// ---- Lines that aren't parallel still get an angle ----
await load([
  { type: 'line', id: 'A', p1: P('a1', -30, 0), p2: P('a2', 30, 0) },
  { type: 'line', id: 'C', p1: P('c1', -30, 10), p2: P('c2', 30, 20) },
]);
const ang = await dimension([[0, 0], [0, 15]], [40, 12], 20);
check(ang && ang.kind === 'angle', `lines that aren't parallel give an angle (${ang && ang.kind})`);

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

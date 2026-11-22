// End-to-end test: Trace path (core/locus.js, app/locus.js). Right-click a
// point of a mechanism → "Trace path of this point": its positions are drawn
// as a dashed ink stroke that remembers the point; changing the sketch marks
// it out of date until Recompute; saved with the drawing; fixed and free
// points explain why there is no path.
//
// Usage: node tests/locus.e2e.mjs [rootDir]
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
const SHOT = process.env.SHOT;
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);

// Slider-crank: O fixed, crank O–A 20, rod A–B 60, B slides on the
// horizontal line through O. Plus a fixed point F and a free point Q.
await page.evaluate(() => {
  const a = window._app, P = (id, x, y) => ({ type: 'point', id, x, y });
  a.project = a.project.constructor.fromJSON({ version: 5, units: 'mm', activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }],
    sketches: [{ id: 's', name: 'S', entities: [
      { type: 'line', id: 'crank', p1: P('o', 0, 0), p2: P('a', 0, 20) },
      { type: 'line', id: 'rod', p1: P('a2', 0, 20), p2: P('b', Math.sqrt(3200), 0) },
      { type: 'line', id: 'slide', p1: P('o2', 0, 0), p2: P('b2', Math.sqrt(3200), 0), construction: true },
      { type: 'point', id: 'f', x: -30, y: 30 },
      { type: 'point', id: 'q', x: -30, y: -30 },
    ], constraints: [
      { id: 'fo', kind: 'fix', pointId: 'o', x: 0, y: 0 },
      { id: 'ff', kind: 'fix', pointId: 'f', x: -30, y: 30 },
      { id: 'c1', kind: 'coincident', p1: 'a', p2: 'a2' },
      { id: 'c2', kind: 'coincident', p1: 'o', p2: 'o2' },
      { id: 'c3', kind: 'coincident', p1: 'b', p2: 'b2' },
      { id: 'h', kind: 'horizontal', lineId: 'slide', p1: 'o2', p2: 'b2' },
      { id: 'd1', kind: 'distance', p1: 'o', p2: 'a', value: 20, name: 'D1' },
      { id: 'd2', kind: 'distance', p1: 'a2', p2: 'b', value: 60, name: 'D2' },
    ] }] });
  a._afterStateSwap();
  for (const w of ['colors', 'tools', 'sketch', 'layers', 'equations']) a.windows.toggle(w, false);
  a.windows.toggle('props', true);
  a.view.zoom = 5; a.view.panX = -150; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.refreshUI(); a._render();
});
const scr = (x, y) => page.evaluate(([x, y]) => { const a = window._app, b = a.canvas.getBoundingClientRect(), s = a.view.worldToScreen({ x, y }); return { x: b.left + s.x, y: b.top + s.y }; }, [x, y]);
const paths = () => page.evaluate(() => window._app.activeSketch().strokes.filter(s => s.traces).map(s => ({ point: s.traces.point, closed: s.traces.closed, ends: s.traces.ends, dash: !!s.dash, kind: s.kind, n: s.points.length, stale: !!s._stale,
  r: s.points.map(p => Math.hypot(p.x, p.y)), xs: s.points.map(p => p.x), ys: s.points.map(p => p.y) })));
const geom = () => page.evaluate(() => window._app.activeSketch().entities.flatMap(e => [e, ...e.children()]).filter(p => p.constructor.kind === 'point').map(p => [p.id, +p.x.toFixed(9), +p.y.toFixed(9)]).join(' '));
const hint = () => page.textContent('#status-hint');

// ---- Right-click the crank end A: a closed circle of radius 20 ----
const g0 = await geom();
let at = await scr(0, 20);
await page.mouse.click(at.x, at.y, { button: 'right' });
check(await page.isVisible('#context-menu [data-action="trace-path"]'), 'right-clicking a point offers "Trace path of this point"');
const t0 = Date.now();
await page.click('#context-menu [data-action="trace-path"]');
const took = Date.now() - t0;
let k = await paths();
check(k.length === 1 && k[0].point === 'a' && k[0].closed && k[0].kind === 'pen' && k[0].dash, `a closed, dashed ink path for A (${JSON.stringify(k.map(x => ({ point: x.point, closed: x.closed, ends: x.ends, n: x.n })))}, ${took} ms)`);
check(k[0] && Math.max(...k[0].r.map(r => Math.abs(r - 20))) < 0.05, `A's path is the crank circle, radius 20 (max error ${k[0] && Math.max(...k[0].r.map(r => Math.abs(r - 20))).toFixed(4)})`);
check(await geom() === g0, 'tracing leaves the geometry exactly as it was');
check(/Closed path/.test(await hint()), `the status bar says so ("${(await hint()).slice(0, 50)}")`);
check(/traced path/i.test(await page.innerText('#sel-body')) && /up to date/.test(await page.innerText('#sel-body')), 'Properties: traced path, up to date');

// ---- The slider end B: a segment from 40 to 80, stopping where it locks ----
await page.keyboard.press('Escape');
at = await scr(Math.sqrt(3200), 0);
await page.mouse.click(at.x, at.y, { button: 'right' });
await page.click('#context-menu [data-action="trace-path"]');
k = await paths();
const b = k.find(x => x.point === 'b');
check(b && !b.closed && b.ends.join() === 'locked,locked', `B's path is open, both ends where the mechanism locks (${b && b.ends})`);
check(b && Math.min(...b.xs) < 40.05 && Math.max(...b.xs) > 79.95 && Math.max(...b.ys.map(Math.abs)) < 1e-4, `B slides from 40 to 80 on the axis (${b && Math.min(...b.xs).toFixed(3)}..${b && Math.max(...b.xs).toFixed(3)})`);
if (SHOT) await page.screenshot({ path: SHOT + '-paths.png' });

// ---- Change the crank: both paths out of date; Recompute ----
await page.evaluate(() => { const a = window._app; a.setDimensionFromText(a.activeSketch().constraints.find(c => c.name === 'D1'), '25'); a._render(); });
k = await paths();
check(k.every(x => x.stale), 'changing the crank length marks both paths out of date');
await page.evaluate(() => { const a = window._app, s = a.activeSketch().strokes.find(x => x.traces?.point === 'a'); a.clearSelection(); a.selectInk(s, true); a.refreshUI(); a._render(); });
check(/out of date/.test(await page.innerText('#sel-body')), 'Properties says out of date');
if (SHOT) await page.screenshot({ path: SHOT + '-stale.png' });
await page.click('#sel-body [data-ink-act="recompute-path"]');
k = await paths();
const a2 = k.find(x => x.point === 'a');
check(a2 && !a2.stale && Math.max(...a2.r.map(r => Math.abs(r - 25))) < 0.05, 'Recompute: radius 25 now, up to date');
check(k.find(x => x.point === 'b').stale, 'the other path stays out of date until recomputed');
// recompute from the right-click menu of the path
await page.evaluate(() => { const a = window._app, s = a.activeSketch().strokes.find(x => x.traces?.point === 'b'); a.clearSelection(); a.selectInk(s, true); a.refreshUI(); });
await page.evaluate(() => { const a = window._app, s = a.activeSketch().strokes.find(x => x.traces?.point === 'b'); a._inkMenuTarget = s; window.__acts = a.inkContextActions().map(x => x.id); a.inkContextActions().find(x => x.id === 'recompute-path').run(); });
check((await page.evaluate(() => window.__acts)).includes('recompute-path'), 'a traced path\'s right-click menu offers Recompute path');
k = await paths();
const b2 = k.find(x => x.point === 'b');
check(b2 && !b2.stale && Math.min(...b2.xs) < 35.05 && Math.max(...b2.xs) > 84.95, `B now slides from 35 to 85 (${Math.min(...b2.xs).toFixed(2)}..${Math.max(...b2.xs).toFixed(2)})`);

// ---- Ink like any other: restyle, undo, saved ----
const json = await page.evaluate(() => JSON.stringify(window._app.project.toJSON()));
const back = await page.evaluate((j) => { const P = window._app.project.constructor.fromJSON(JSON.parse(j)); return P.sketches[0].strokes.filter(s => s.traces).map(s => [s.traces.point, s.dash, s.traces.closed]); }, json);
check(JSON.stringify(back) === JSON.stringify([['a', true, true], ['b', true, false]]), `saved and loaded with their point (${JSON.stringify(back)})`);

// ---- Fixed and free points: no path, and why ----
await page.keyboard.press('Escape');
for (const [id, x, y, re, what] of [['f', -30, 30, /can't move/, 'a fixed point'], ['q', -30, -30, /two directions/, 'a free point']]) {
  at = await scr(x, y);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.click('#context-menu [data-action="trace-path"]');
  check(re.test(await hint()) && !(await paths()).some(p => p.point === id), `${what}: no path, the status bar says why ("${(await hint()).slice(0, 60)}…")`);
}

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

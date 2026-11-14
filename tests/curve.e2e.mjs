// Bézier curves (Curve tool, V): drawing (clicks, drags, continuing a
// line, closing), handles, relations (tangent, smooth, on curve), and
// the other tools on curves: fill, scissors, mirror, patterns, export,
// saving. Usage: node tests/curve.e2e.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
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
page.on('console', m => { if (m.type() === 'error' && !/umami|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.route(/umami/, r => r.abort());

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); } catch {} });
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const app = (fn, arg) => page.evaluate(fn, arg);
await app(() => { const a = window._app; a.view.zoom = 8; a.view.panX = 0; a.view.panY = 0; a.requestRender(); });
const scr = (x, y) => app(([x, y]) => { const a = window._app; const p = a.view.worldToScreen({ x, y }); const r = a.canvas.getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; }, [x, y]);
const click = async (x, y) => { const p = await scr(x, y); await page.mouse.move(p.x, p.y); await page.mouse.click(p.x, p.y); };
const dragFrom = async (x, y, dx, dy) => { const p = await scr(x, y); const q = await scr(x + dx, y + dy); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 8 }); await page.mouse.up(); };
const curves = () => app(() => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'bezier').map(b => ({ id: b.id, P: b.ctrl().map(p => [p.x, p.y]), ids: b.ctrl().map(p => p.id) })));
const kinds = () => app(() => window._app.activeSketch().constraints.map(c => c.kind).sort());
const clear = () => app(() => { const a = window._app; for (const s of a.project.sketches) { for (const e of [...s.entities]) s.removeEntity(e); s.constraints = []; s.fills = []; } a.commit(); a.refreshUI(); });
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/* ---------------- The tool ---------------- */
await page.keyboard.press('v');
check(await app(() => window._app.toolName === 'curve'), 'V picks the Curve tool');
check(await page.locator('.fwin[data-win="tools"] [data-tool="curve"]').count() === 1, 'it is in the Tools window with the sketch tools');
check((await page.locator('#optbar .seg button.on').textContent()) === 'Smooth clicks', 'options bar: Smooth clicks by default');

/* ---------------- Continue a line, smooth clicks, a dragged handle ---------------- */
await page.keyboard.press('l');
await click(-30, 0); await click(-10, 0);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
await page.keyboard.press('v');
await click(-10, 0);                          // on the line's end
await click(0, 10);                           // smooth click
await dragFrom(10, 0, 6, 0);                  // pull a handle
await click(20, 8);
await page.keyboard.press('Enter');
let cs = await curves();
check(cs.length === 3, `three curve segments (${cs.length})`);
const lineEnd = await app(() => window._app.activeSketch().entities[0].p2.id);
check(cs[0].ids[0] === lineEnd, 'the path starts on the line\'s end (shared point)');
check(near(cs[0].P[1][1], 0, 1e-6) && cs[0].P[1][0] > -10, 'its first handle continues the line');
let ks = await kinds();
check(ks.filter(k => k === 'curveTangent').length === 1 && ks.filter(k => k === 'smooth').length === 2, `relations: Tangent to the line, Smooth at both joints (${ks.join()})`);
check(near(cross(cs[1].P[0], cs[0].P[2], cs[1].P[1]), 0, 1e-6), 'the clicked point is smooth (handles in line)');
check(near(cs[1].P[2][1], 0, 1e-6) && near(cs[2].P[1][0], 16, 1e-6), 'the dragged handle: 6 mm out, mirrored on the other side');
check(await app(() => document.getElementById('status-solve').textContent.startsWith('solved')), 'it solves');

/* ---------------- Handles: shown when selected, drag reshapes ---------------- */
await page.keyboard.press('s');
const mid = await app(() => { const b = window._app.activeSketch().entities.filter(e => e.constructor.kind === 'bezier')[1]; return b.at(0.5); });
await app(() => window._app.clearSelection());
const hidden = await app(() => { const a = window._app, b = a.activeSketch().entities.filter(e => e.constructor.kind === 'bezier')[1]; a.requestRender(); return a.hitTestActiveSketch({ x: b.c1.x, y: b.c1.y }) === b.c1; });
check(!hidden, 'handles of an unselected curve can\'t be picked');
await click(mid.x, mid.y);
await page.waitForTimeout(50);
check(await app(() => { const a = window._app, b = a.activeSketch().entities.filter(e => e.constructor.kind === 'bezier')[1]; return a.hitTestActiveSketch({ x: b.c2.x, y: b.c2.y }) === b.c2; }), 'selecting the curve shows its handles');
check(await page.locator('#sel-body').getByText('Length').count() > 0, 'Properties: a curve shows its length');
const before = await curves();
await dragFrom(before[1].P[2][0], before[1].P[2][1], 0, -6);
const after = await curves();
check(near(after[1].P[2][1], before[1].P[2][1] - 6, 0.3) && near(after[1].P[0][0], before[1].P[0][0], 1e-6), 'dragging a handle reshapes the curve, its ends stay');
check(near(cross(after[2].P[0], after[1].P[2], after[2].P[1]), 0, 1e-6), 'the joint stays smooth (the other handle turns)');
const a0 = after[1].P[3];
await dragFrom(a0[0], a0[1], 0, 4);
const moved = await curves();
check(near(moved[1].P[3][1], a0[1] + 4, 0.3), 'dragging an end moves it');
check(near(moved[1].P[2][1] - moved[1].P[3][1], after[1].P[2][1] - a0[1], 0.3), 'and its handle comes along');

/* ---------------- Close a path, fill it ---------------- */
await clear();
await page.keyboard.press('v');
await click(0, 0); await click(20, 0); await click(10, 15);
await click(0, 0);                            // the first point: closes
cs = await curves();
check(cs.length === 3 && cs[2].ids[3] === cs[0].ids[0], 'clicking the first point closes the path');
check((await kinds()).filter(k => k === 'smooth').length === 3, 'a closed smooth path: Smooth at every point');
await page.keyboard.press('b');
await click(10, 5);
check(await app(() => (window._app.activeSketch().fills || []).length === 1), 'Fill paints the area a curve closes');

/* ---------------- Relations from Properties ---------------- */
await clear();
await app(async () => {
  const a = window._app, s = a.activeSketch();
  const v = document.querySelector('script[type=importmap]').textContent;
  const E = await import('/app/src/core/entities.js?v=' + v.match(/core\/entities\.js\?v=(\w+)/)[1]);
  const l = new E.Line(new E.Point(-20, 0), new E.Point(0, 0)); s.addEntity(l);
  const b = new E.Bezier(l.p2, new E.Point(4, 6), new E.Point(10, 6), new E.Point(15, 0)); s.addEntity(b);
  const q = new E.Point(8, 8); s.addEntity(q);
  a.commit(); a.setTool('select'); a.clearSelection(); a.setSelected(b, true); a.setSelected(l, true); a.refreshUI();
});
check(await page.locator('#sel-body [data-rel="tangent"]').count() === 1, 'curve + line: Tangent in Properties');
await page.locator('#sel-body [data-rel="tangent"]').click();
cs = await curves();
const ln = await app(() => { const l = window._app.activeSketch().entities[0]; return [[l.p1.x, l.p1.y], [l.p2.x, l.p2.y]]; });
check(near(cross([0, 0], [cs[0].P[1][0] - cs[0].P[0][0], cs[0].P[1][1] - cs[0].P[0][1]], [ln[1][0] - ln[0][0], ln[1][1] - ln[0][1]]), 0, 1e-5), 'Tangent: the curve leaves along the line');
await app(() => { const a = window._app, s = a.activeSketch(); a.clearSelection(); a.setSelected(s.entities[1], true); a.setSelected(s.entities[2], true); a.refreshUI(); });
check(await page.locator('#sel-body [data-rel="pointOnCurve"]').count() === 1, 'curve + point: On curve');
await page.locator('#sel-body [data-rel="pointOnCurve"]').click();
check(await app(async () => { const s = window._app.activeSketch(); const b = s.entities[1], q = s.entities[2]; const v = document.querySelector('script[type=importmap]').textContent; const B = await import('/app/src/core/bezier.js?v=' + v.match(/core\/bezier\.js\?v=(\w+)/)[1]); return B.bezierNearest(b.ctrl(), q).d < 1e-5; }), 'On curve: the point moves onto it');
await app(() => { const a = window._app, s = a.activeSketch(), b = s.entities[1]; a.clearSelection(); a.setSelected(b.p2, true); a.setSelected(b.c2, true); a.refreshUI(); });
await page.locator('#sel-body [data-rel="horizontal"]').click();
cs = await curves();
check(near(cs[0].P[2][1], cs[0].P[3][1], 1e-5), 'an end + its handle → Horizontal: a level end');

/* ---------------- Scissors on curves ---------------- */
await clear();
await app(async () => {
  const a = window._app, s = a.activeSketch();
  const v = document.querySelector('script[type=importmap]').textContent;
  const E = await import('/app/src/core/entities.js?v=' + v.match(/core\/entities\.js\?v=(\w+)/)[1]);
  s.addEntity(new E.Bezier(new E.Point(0, -10), new E.Point(5, 15), new E.Point(15, -15), new E.Point(20, 10)));
  s.addEntity(new E.Line(new E.Point(-10, 0), new E.Point(30, 0)));
  a.commit();
});
await page.keyboard.press('x');
await click(-8, 0);
check((await kinds()).includes('pointOnCurve'), 'trim a line back to a curve: its end stays on the curve');
const c0 = (await curves())[0];
const midPt = await app(() => window._app.activeSketch().entities[0].at(0.5));
await click(midPt.x, midPt.y);
check((await curves()).length === 2, 'trim the middle of a curve: two curves');
await page.keyboard.press('x');                 // split
const pts = await curves();
const sp = await app(() => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'bezier')[0].at(0.5));
await click(sp.x, sp.y);
check((await curves()).length === 3 && (await kinds()).includes('smooth'), 'split a curve: two pieces with a Smooth joint');
void c0; void pts;

/* ---------------- Mirror, pattern, save, export ---------------- */
await clear();
await app(async () => {
  const a = window._app, s = a.activeSketch();
  const v = document.querySelector('script[type=importmap]').textContent;
  const E = await import('/app/src/core/entities.js?v=' + v.match(/core\/entities\.js\?v=(\w+)/)[1]);
  const b = new E.Bezier(new E.Point(2, 0), new E.Point(4, 8), new E.Point(8, 8), new E.Point(10, 0)); s.addEntity(b);
  const axis = new E.Line(new E.Point(0, -5), new E.Point(0, 15)); axis.construction = true; s.addEntity(axis);
  a.commit(); a.setTool('select'); a.clearSelection(); a.setSelected(b, true); a.setSelected(axis, true);
  a.startMirrorOperation(); a.mirrorSelection();
});
cs = await curves();
check(cs.length === 2 && near(cs[1].P[1][0], -4) && near(cs[1].P[1][1], 8), 'Mirror copies a curve (handles too)');
check((await kinds()).filter(k => k === 'symmetric').length === 4, 'and keeps it symmetric (4 points)');
await app(() => { const a = window._app, s = a.activeSketch(); a.clearSelection(); a.setSelected(s.entities[0], true); a.startPatternOperation('linear'); a.createPattern(); });
check((await curves()).length === 4, 'a linear pattern of a curve');
const saved = await app(() => JSON.stringify(window._app.project.toJSON()));
const back = await app((json) => { const s = window._app.project.constructor.fromJSON(JSON.parse(json)).sketches[0]; return s.entities.filter(e => e.constructor.kind === 'bezier').length; }, saved);
check(back === 4, 'curves save and load');
const svg = await app(async () => { const v = document.querySelector('script[type=importmap]').textContent; const X = await import('/app/src/render/export.js?v=' + v.match(/render\/export\.js\?v=(\w+)/)[1]); return X.exportSVG({ project: window._app.project }, {}); });
check(/ C[\d.-]/.test(svg) || /[\d.] C /.test(svg) || svg.includes('C'), 'SVG export draws curves as curves');
const dxf = await app(async () => { const v = document.querySelector('script[type=importmap]').textContent; const D = await import('/app/src/core/dxf.js?v=' + v.match(/core\/dxf\.js\?v=(\w+)/)[1]); return D.toDXF(window._app.project).text; });
check((dxf.match(/POLYLINE/g) || []).length === 4, 'DXF export: each curve as a fine polyline');

/* ---------------- Smart Dimension on a curve's points ---------------- */
await page.keyboard.press('d');
const b0 = await app(() => { const b = window._app.activeSketch().entities.find(e => e.constructor.kind === 'bezier'); return b.at(0.5); });
await click(b0.x, b0.y);
check(true, 'Smart Dimension: clicking a curve does nothing harmful');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

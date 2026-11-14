// Scissors tool (X): trim to the nearest crossings (click, power-trim
// stroke), split lines / arcs / circles, what happens to relations, undo,
// patterns left alone. Usage: node tests/scissors.e2e.mjs
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
// world ↔ screen
const at = async (x, y) => app(([x, y]) => { const a = window._app; const p = a.view.worldToScreen({ x, y }); const r = a.canvas.getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; }, [x, y]);
const click = async (x, y, opts) => { const p = await at(x, y); await page.mouse.click(p.x, p.y, opts); };
const move = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y); };
const state = () => app(() => {
  const s = window._app.activeSketch();
  return {
    kinds: s.entities.map(e => e.constructor.kind),
    cons: s.constraints.map(c => c.kind).sort(),
    lines: s.entities.filter(e => e.constructor.kind === 'line').map(l => [l.p1.x, l.p1.y, l.p2.x, l.p2.y]),
    solved: document.getElementById('status-solve').textContent,
  };
});
/** Draws with the app's own model (exact coordinates), one undo step. */
const build = (code) => app(async (code) => {
  const a = window._app, s = a.activeSketch();
  const v = document.querySelector('script[type=importmap]').textContent;
  const ver = (f) => (v.match(new RegExp(f.replace('.', '\\.') + '\\?v=(\\w+)')) || [])[1];
  const E = await import('/app/src/core/entities.js?v=' + ver('core/entities.js'));
  const C = await import('/app/src/core/constraints.js?v=' + ver('core/constraints.js'));
  for (const e of [...s.entities]) s.removeEntity(e);
  s.constraints = [];
  const out = new Function('E', 'C', 's', code)(E, C, s);
  a.commit(); a.refreshUI(); a.requestRender();
  return out;
}, code);
const dismissNotice = () => app(() => document.querySelectorAll('.toast, .notice').forEach(n => n.remove()));

await app(() => { const a = window._app; a.view.zoom = 8; a.view.panX = 0; a.view.panY = 0; a.requestRender(); });

/* ---------------- Tool, options bar, hover ---------------- */
await page.keyboard.press('x');
check(await app(() => window._app.toolName === 'trim'), 'X picks the Scissors');
check((await page.locator('#optbar .seg button.on').textContent()) === 'Trim', 'options bar: Trim / Split, Trim first');
await page.keyboard.press('x');
check(await app(() => window._app.scissorsMode === 'split'), 'X again switches to Split');
await page.locator('#optbar [data-opt="scissors-trim"]').click();
check(await app(() => window._app.scissorsMode === 'trim'), 'the options bar switches back to Trim');

/* ---------------- Trim the middle of a line ---------------- */
await build(`
  const h = new E.Line(new E.Point(-30, 0), new E.Point(30, 0)); s.addEntity(h);
  s.addEntity(new E.Line(new E.Point(-10, -10), new E.Point(-10, 10)));
  s.addEntity(new E.Line(new E.Point(10, -10), new E.Point(10, 10)));
  s.constraints.push(new C.HorizontalConstraint(h.id, h.p1.id, h.p2.id));
  const far = new E.Line(new E.Point(-30, 40), new E.Point(30, 40)); s.addEntity(far);
  s.constraints.push(new C.EqualLengthConstraint({ a: h.p1.id, b: h.p2.id }, { a: far.p1.id, b: far.p2.id }));
`);
await move(0, 0.2);
const prev = await app(() => window._app.tool.getPreview()?.cut);
check(prev?.remove?.kind === 'line' && Math.abs(prev.remove.a.x + 10) < 1e-6 && Math.abs(prev.remove.b.x - 10) < 1e-6, 'hover: the piece between the two crossings is shown');
check(prev?.ends?.length === 2, 'hover: the two cuts are marked');
await click(0, 0.2);
let st = await state();
check(st.lines.length === 5, 'click: the middle goes, two lines remain');
check(st.lines.some(l => near(l[0], -30) && near(l[2], -10)) && st.lines.some(l => near(l[0], 10) && near(l[2], 30)), 'click: ends at the crossings ' + JSON.stringify(st.lines));
check(st.cons.join() === 'collinear,horizontal,pointOnLine,pointOnLine', `relations: horizontal kept, pieces collinear, ends on the cutters, equal length removed (${st.cons.join()})`);
check(await page.getByText(/removed Equal length/).count() > 0, 'a note says which relation was removed');
await dismissNotice();
await page.keyboard.press('Control+z');
st = await state();
check(st.lines.length === 4 && st.cons.includes('equalLength'), 'one Undo puts it back');

/* ---------------- Power trim ---------------- */
await build(`
  for (let i = 0; i < 4; i++) s.addEntity(new E.Line(new E.Point(-20 + i * 10, -10), new E.Point(-20 + i * 10, 10)));
  s.addEntity(new E.Line(new E.Point(-30, 0), new E.Point(30, 0)));
`);
const a0 = await at(-25, 5), a1 = await at(25, 5);
await page.mouse.move(a0.x, a0.y); await page.mouse.down();
await page.mouse.move(a1.x, a1.y, { steps: 12 });
const trail = await app(() => !!window._app.tool.getPreview()?.cut?.trail);
await page.mouse.up();
st = await state();
const tops = st.lines.filter(l => Math.abs(l[0] - l[2]) < 1e-9).map(l => Math.max(l[1], l[3]));
check(tops.length === 4 && tops.every(y => near(y, 0)), `drag across: the 4 upper halves go (${tops.map(y => y.toFixed(2)).join(', ')})`);
check(trail, 'drag: the stroke is drawn');
await page.keyboard.press('Control+z');
check((await state()).lines.every(l => Math.abs(l[0] - l[2]) > 1e-9 || near(Math.max(l[1], l[3]), 10)), 'the whole stroke is one undo step');

/* ---------------- Circle → arc with the same id ---------------- */
const cid = await build(`
  const c = new E.Circle(new E.Point(0, 0), 10); s.addEntity(c);
  s.addEntity(new E.Line(new E.Point(-20, 5), new E.Point(20, 5)));
  s.constraints.push(new C.RadiusConstraint(c.id, 10));
  return c.id;
`);
await click(0, 10);
st = await state();
check(st.kinds.includes('arc') && !st.kinds.includes('circle'), 'trimming a crossed circle leaves an arc');
check(await app((id) => window._app.activeSketch().entities.find(e => e.id === id)?.constructor.kind === 'arc', cid), 'the arc keeps the circle\'s id (fills, links, names)');
check(st.cons.join() === 'arcEndpointOnLine,arcEndpointOnLine,radius', 'radius kept, arc ends stay on the line');

/* ---------------- Nothing crossing: the whole shape ---------------- */
await build(`s.addEntity(new E.Circle(new E.Point(0, 0), 5));`);
await click(5, 0);
check((await state()).kinds.length === 0, 'a shape nothing crosses goes whole');

/* ---------------- Split: line, arc, circle ---------------- */
await page.keyboard.press('x');
await build(`
  const h = new E.Line(new E.Point(-20, 0), new E.Point(20, 0)); s.addEntity(h);
  s.addEntity(new E.Line(new E.Point(7, -5), new E.Point(7, 5)));
  s.constraints.push(new C.HorizontalConstraint(h.id, h.p1.id, h.p2.id));
`);
await move(6.5, 0);
check(await app(() => window._app.tool.getPreview()?.cut?.split?.snapped === 'cut'), 'split: the spot snaps to the crossing');
await click(6.5, 0);
st = await state();
check(st.lines.filter(l => near(l[1], 0) && near(l[3], 0)).length === 2, 'split: two lines');
check(st.lines.some(l => near(l[2], 7) && near(l[3], 0)), 'split: at the crossing');
check(st.cons.join() === 'collinear,horizontal,pointOnLine', `split: collinear, horizontal kept, joint on the cutter (${st.cons.join()})`);
await move(0, 0);
check(await app(() => window._app.tool.getPreview()?.cut?.split?.snapped !== 'mid'), 'split: the middle of the original line no longer snaps');

await build(`
  const c = new E.Circle(new E.Point(0, 0), 10); s.addEntity(c);
  s.constraints.push(new C.FixConstraint(c.center.id, 0, 0));
`);
await click(10, 0);
check(await app(() => !!window._app.tool.pending) && (await state()).kinds.join() === 'circle', 'circle: the first click marks a spot');
await click(-10, 0);
st = await state();
check(st.kinds.join() === 'arc,arc', 'circle: the second click splits it into two arcs');
await app(() => window._app.solveAndRender());
const diag = await app(() => ({ red: window._app._lastSolve?.redundant, dof: window._app._lastSolve?.dof, st: window._app._lastSolve?.state }));
check(diag.red === 0 && diag.dof === 3, `circle: no redundant relation, the joints and radius free (${JSON.stringify(diag)})`);

/* ---------------- Patterns are left alone ---------------- */
await page.keyboard.press('x');            // back to trim
await build(`
  s.addEntity(new E.Circle(new E.Point(0, 0), 3));
  s.addEntity(new E.Line(new E.Point(-20, 0), new E.Point(40, 0)));
`);
await app(() => { const a = window._app, s = a.activeSketch(); a.clearSelection(); a.setSelected(s.entities[0], true); a.startPatternOperation('linear'); a.createPattern(); a.setTool('trim'); });
const before = (await state()).kinds.length;
await click(0, 3);
check((await state()).kinds.length === before, 'a linked pattern\'s shape isn\'t cut');
check(await page.getByText(/unlink the pattern first/).count() > 0, 'and a note says to unlink it first');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

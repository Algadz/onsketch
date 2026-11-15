// End-to-end test of the horizontal / vertical guess when a line end snaps
// to a shape (on a line, circle: it slides to the crossing) or a point.
//
// Usage: node tests/axis.e2e.mjs [rootDir]
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
const load = () => page.evaluate((proj) => {
  const a = window._app;
  a.project = a.project.constructor.fromJSON(proj);
  a._afterStateSwap();
  a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0;
  a.commit({ diagnostics: 'sync' }); a.setTool('select');
  for (const w of ['colors', 'tools', 'sketch', 'equations', 'props', 'layers']) a.windows.toggle(w, false);
  a.refreshUI();
}, { version: 3, activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }],
  sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'S', p1: P('s1', 20, -30), p2: P('s2', 40, 30) },        // slanted
    { type: 'circle', id: 'C', center: P('c', -50, 0), r: 20 },
    { type: 'point', id: 'pt', x: 60, y: 40 },
    { type: 'point', id: 'pt2', x: 60, y: 60.6 },
  ], constraints: [
    { id: 'f1', kind: 'fix', pointId: 's1', x: 20, y: -30 }, { id: 'f2', kind: 'fix', pointId: 's2', x: 40, y: 30 },
    { id: 'f3', kind: 'fix', pointId: 'c', x: -50, y: 0 }, { id: 'f4', kind: 'radius', circleId: 'C', value: 20 },
    { id: 'f5', kind: 'fix', pointId: 'pt', x: 60, y: 40 }, { id: 'f6', kind: 'fix', pointId: 'pt2', x: 60, y: 60.6 },
  ] }] });
const scr = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
const lastLine = () => page.evaluate(() => {
  const s = window._app.activeSketch(), l = s.entities.filter(e => e.constructor.kind === 'line').at(-1);
  const kinds = s.constraints.filter(c => c.refs().some(r => r === l.id || r === l.p1.id || r === l.p2.id) && !['fix', 'radius'].includes(c.kind)).map(c => c.kind).sort();
  return { p1: [+l.p1.x.toFixed(6), +l.p1.y.toFixed(6)], p2: [+l.p2.x.toFixed(6), +l.p2.y.toFixed(6)], kinds: kinds.join(','), id: l.id };
});
const draw = async (from, to, { alt = false } = {}) => {
  await page.keyboard.press('l');
  const a = await scr(...from), b = await scr(...to);
  await page.mouse.click(a.x, a.y);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(b.x, b.y, { steps: 4 });
  const hint = await page.evaluate(() => { const h = document.getElementById('cursor-hint'); return h.style.display !== 'none' ? h.textContent : ''; });
  await page.mouse.click(b.x, b.y);
  if (alt) await page.keyboard.up('Alt');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  return { hint, ...(await lastLine()) };
};

// 1. Nearly flat onto a slanted line: the end slides to where the line
//    crosses the horizontal through the start (x = 26 at y = -12).
await load();
let r = await draw([0, -12], [26.3, -11.5]);
check(Math.abs(r.p2[0] - 26) < 1e-6 && Math.abs(r.p2[1] + 12) < 1e-6, `end on the slanted line, level with the start (${r.p2})`);
check(r.kinds === 'horizontal,pointOnLine', `relations: on the line + horizontal (${r.kinds})`);
check(r.hint === 'on-line · horizontal', `the cursor says "on-line · horizontal" (${r.hint})`);

// 2. Nearly upright onto a circle: the end goes to where the circle crosses
//    the vertical through the start.
await load();
r = await draw([-40, -60], [-40.4, -17.6]);
const yc = -Math.sqrt(400 - 100);
check(Math.abs(r.p2[0] + 40) < 1e-6 && Math.abs(r.p2[1] - yc) < 1e-5, `end on the circle, straight above the start (${r.p2}, expected y ${yc.toFixed(4)})`);
check(r.kinds === 'pointOnCircle,vertical', `relations: on the circle + vertical (${r.kinds})`);

// 3. A point snap in line gets the relation; one a few px off doesn't move.
await load();
r = await draw([0, 40], [60.2, 40.3]);
check(r.p2[0] === 60 && r.p2[1] === 40 && /horizontal/.test(r.kinds), `onto a point exactly level: horizontal added (${r.kinds})`);
await load();
r = await draw([0, 60], [60, 60.6]);
check(r.p2[1] === 60.6 && !/horizontal/.test(r.kinds), `onto a point 3 px off level: no horizontal, nothing pulled (${r.p2} · ${r.kinds || 'none'})`);

// 4. Far from the crossing: plain snap where the cursor is, no guess.
await load();
r = await draw([0, 0], [36, 18]);
check(!/horizontal|vertical/.test(r.kinds) && r.kinds === 'pointOnLine', `steep onto the line: just on the line (${r.kinds})`);

// 5. Alt: no snap, no guess.
await load();
r = await draw([0, -12], [26.3, -11.5], { alt: true });
check(r.kinds === '' && r.p2[1] !== -12, `with Alt: neither (${r.p2} · ${r.kinds || 'none'})`);

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

// End-to-end test of Alt = no snap while placing or dragging (desktop),
// and Space-drag panning (Alt no longer pans).
//
// Usage: node tests/nosnap.e2e.mjs [rootDir]
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
    { type: 'line', id: 'A', p1: P('a1', -30, 0), p2: P('a2', 0, 0) },
    { type: 'line', id: 'B', p1: P('b1', 10, 20), p2: P('b2', 30, 20) },
  ], constraints: [] }] });
const scr = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
const W = (q) => page.evaluate(([x, y]) => window._app.view.screenToWorld({ x, y }), [q.x - box.x, q.y - box.y]);
const state = () => page.evaluate(() => {
  const a = window._app, s = a.activeSketch();
  return {
    snap: a.lastSnap ? a.lastSnap.kind : null,
    hint: document.getElementById('cursor-hint').style.display !== 'none' ? document.getElementById('cursor-hint').textContent : '',
    heldOff: document.querySelector('#menubar [data-action="snap"]').classList.contains('held-off'),
    kinds: s.constraints.map(c => c.kind).sort().join(','),
    lines: s.entities.filter(e => e.constructor.kind === 'line').length,
  };
});

// ---- Placing with the Line tool ----
await load();
await page.keyboard.press('l');
check(/Alt|Option/.test(await page.textContent('#optbar')), 'the options bar says Alt places without snapping');
const end = await scr(0, 0);
const near = { x: end.x + 4, y: end.y + 3 };                    // a few px off A's end
await page.mouse.move(near.x, near.y, { steps: 2 });
let st = await state();
check(st.snap === 'endpoint', `without Alt the cursor snaps to the end (${st.snap})`);
await page.keyboard.down('Alt');
st = await state();
check(!st.snap && st.hint === 'no snap' && st.heldOff, `pressing Alt drops the snap at once, says "no snap", dims Snap (${JSON.stringify(st)})`);
await page.mouse.click(near.x, near.y);
const far = { x: near.x + 120, y: near.y + 2 };                 // almost horizontal: no Horizontal with Alt
await page.mouse.move(far.x, far.y, { steps: 3 });
await page.mouse.click(far.x, far.y);
await page.keyboard.up('Alt');
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
st = await state();
const placed = await page.evaluate(() => { const s = window._app.activeSketch(); const l = s.entities.at(-1); return { p1: [l.p1.x, l.p1.y], p2: [l.p2.x, l.p2.y], shared: l.p1 === s.entities[0].p2 }; });
const w1 = await W(near), w2 = await W(far);
check(!placed.shared && Math.abs(placed.p1[0] - w1.x) < 1e-6 && Math.abs(placed.p1[1] - w1.y) < 1e-6, 'with Alt the start goes exactly under the cursor (not on the end)');
check(Math.abs(placed.p2[1] - w2.y) < 1e-6 && placed.p2[1] !== placed.p1[1], 'with Alt a nearly flat line stays as drawn');
check(st.kinds === '', `with Alt no relation is added (${st.kinds || 'none'})`);
check(!st.heldOff, 'releasing Alt brings Snap back');

// the same strokes without Alt snap and infer
await load();
await page.keyboard.press('l');
await page.mouse.click(near.x, near.y);
await page.mouse.move(far.x, far.y, { steps: 3 });
await page.mouse.click(far.x, far.y);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
st = await state();
check(/horizontal/.test(st.kinds), `without Alt the same line gets Horizontal (${st.kinds})`);

// ---- Dragging ----
await load();
await page.keyboard.press('s');
const b1 = await scr(10, 20), target = await scr(0, 0);
const drop = { x: target.x + 3, y: target.y - 2 };
await page.keyboard.down('Alt');
await page.mouse.move(b1.x, b1.y); await page.mouse.down();
await page.mouse.move((b1.x + drop.x) / 2, (b1.y + drop.y) / 2, { steps: 4 });
await page.mouse.move(drop.x, drop.y, { steps: 4 });
st = await state();
check(!st.snap && st.hint === 'no snap', 'dragging with Alt shows no snap');
await page.mouse.up();
await page.keyboard.up('Alt');
let dragged = await page.evaluate(() => { const s = window._app.activeSketch(), B = s.entities.find(e => e.id === 'B'); return { p: [B.p1.x, B.p1.y], kinds: s.constraints.map(c => c.kind).join(',') }; });
const wd = await W(drop);
check(Math.abs(dragged.p[0] - wd.x) < 1e-6 && Math.abs(dragged.p[1] - wd.y) < 1e-6 && dragged.kinds === '', `the end lands under the cursor, unattached (${JSON.stringify(dragged)})`);
// without Alt, the same drop snaps and attaches
await load();
await page.mouse.move(b1.x, b1.y); await page.mouse.down();
await page.mouse.move((b1.x + drop.x) / 2, (b1.y + drop.y) / 2, { steps: 4 });
await page.mouse.move(drop.x, drop.y, { steps: 4 });
await page.mouse.up();
dragged = await page.evaluate(() => { const s = window._app.activeSketch(), B = s.entities.find(e => e.id === 'B'); return { p: [B.p1.x, B.p1.y], kinds: s.constraints.map(c => c.kind).join(',') }; });
check(Math.abs(dragged.p[0]) < 1e-6 && Math.abs(dragged.p[1]) < 1e-6 && /coincident/.test(dragged.kinds), `without Alt it snaps onto the end and attaches (${JSON.stringify(dragged)})`);

// ---- Panning: Space-drag (Alt doesn't pan any more) ----
await load();
const pan0 = await page.evaluate(() => [window._app.view.panX, window._app.view.panY]);
await page.keyboard.down('Alt');
const empty = await scr(-40, -40);
await page.mouse.move(empty.x, empty.y); await page.mouse.down(); await page.mouse.move(empty.x + 60, empty.y + 40, { steps: 4 }); await page.mouse.up();
await page.keyboard.up('Alt');
const pan1 = await page.evaluate(() => [window._app.view.panX, window._app.view.panY]);
check(pan1[0] === pan0[0] && pan1[1] === pan0[1], 'Alt-drag no longer pans');
await page.mouse.move(empty.x, empty.y);
await page.keyboard.down('Space');
check(await page.evaluate(() => window._app.canvas.style.cursor) === 'grab', 'holding Space shows the grab cursor');
await page.mouse.down(); await page.mouse.move(empty.x + 60, empty.y + 40, { steps: 4 }); await page.mouse.up();
await page.keyboard.up('Space');
const pan2 = await page.evaluate(() => [window._app.view.panX, window._app.view.panY]);
check(Math.abs(pan2[0] - pan0[0] - 60) < 1 && Math.abs(pan2[1] - pan0[1] - 40) < 1, `Space-drag pans (${pan2.map(v => (v - pan0[pan2.indexOf(v)]).toFixed(0))})`);
check(await page.evaluate(() => window.scrollY) === 0, 'Space doesn\'t scroll the page');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

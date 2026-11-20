// End-to-end test of groups as in slide editors (click: the group, click again:
// one member, Esc: back) and of clicking through overlapping items.
//
// Usage: node tests/groups.e2e.mjs [rootDir]
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
await page.waitForFunction(() => window._app);
const box = await page.locator('#canvas').boundingBox();
const P = (id, x, y) => ({ type: 'point', id, x, y });
await page.evaluate((proj) => {
  const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
  a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.setTool('select');
  for (const w of ['colors', 'tools', 'sketch', 'layers', 'equations']) a.windows.toggle(w, false);
  a.windows.toggle('props', true); a.refreshUI();
}, { version: 3, activeLayerId: 'front', sizes: { line: 0.4, text: 5 }, layers: [{ id: 'back', name: 'Back' }, { id: 'front', name: 'Front' }],
  sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'L1', layerId: 'front', p1: P('a1', -50, -30), p2: P('a2', 50, -30) },
    { type: 'line', id: 'L2', layerId: 'front', p1: P('b1', -40, -30), p2: P('b2', 60, -30) },
    { type: 'line', id: 'L3', layerId: 'back', p1: P('c1', -45, -30), p2: P('c2', 55, -30) },
  ], constraints: [],
  strokes: [
    { id: 'tA', layerId: 'front', kind: 'text', color: '#111418', opacity: 1, size: 5, text: 'Alpha', group: 'g1', pts: [-40, 20] },
    { id: 'tB', layerId: 'front', kind: 'text', color: '#111418', opacity: 1, size: 5, text: 'Beta', group: 'g1', pts: [20, 20] },
  ] }] });
const S = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
const sel = () => page.evaluate(() => {
  const a = window._app, s = a.activeSketch();
  return [...s.strokes.filter(x => x.selected).map(x => x.id), ...s.entities.filter(e => e.selected).map(e => e.id)].sort().join(',');
});
const pos = (id) => page.evaluate((id) => { const t = window._app.activeSketch().strokes.find(x => x.id === id); return [t.points[0].x, t.points[0].y]; }, id);
const click = async (p) => { await page.mouse.click(p.x, p.y); await page.waitForTimeout(400); };     // apart: not a double-click
const drag = async (p, dx, dy) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + dx / 2, p.y + dy / 2, { steps: 3 }); await page.mouse.move(p.x + dx, p.y + dy, { steps: 3 }); await page.mouse.up(); await page.waitForTimeout(400); };
const hint = () => page.textContent('#status-hint');

// ---- Groups ----
const onA = async () => { const p = await pos('tA'); return S(p[0] + 4, p[1] - 2); };
const onB = async () => { const p = await pos('tB'); return S(p[0] + 4, p[1] - 2); };
await click(await onA());
check(await sel() === 'tA,tB', 'first click on a grouped text selects the group');
let a0 = await pos('tA'), b0 = await pos('tB');
await drag(await onA(), 50, 0);
let a1 = await pos('tA'), b1 = await pos('tB');
check(a1[0] - a0[0] > 5 && Math.abs((b1[0] - b0[0]) - (a1[0] - a0[0])) < 1e-9, 'dragging moves the whole group');
await click(await onA());
check(await sel() === 'tA', 'clicking it again (no drag) selects only that text');
check(await page.evaluate(() => !!window._app._groupFocus), 'the group is entered (dashed frame)');
check(/1 of 2/.test(await page.textContent('#sel-body')) && await page.isVisible('[data-ink-act="select-group"]'), 'Properties says "1 of 2" with Select group');
a0 = await pos('tA'); b0 = await pos('tB');
await drag(await onA(), 0, 40);
a1 = await pos('tA'); b1 = await pos('tB');
check(a1[1] !== a0[1] && b1[1] === b0[1], 'dragging now moves only that member');
await click(await onB());
check(await sel() === 'tB', 'one click on another member selects it (still inside the group)');
await page.keyboard.press('Escape');
check(await sel() === 'tA,tB' && await page.evaluate(() => !window._app._groupFocus), 'Esc: back to the whole group');
await click(await onA()); await click(await onA());
check(await sel() === 'tA', 'enter again');
await click(await S(0, 70));
check(await sel() === '' && await page.evaluate(() => !window._app._groupFocus), 'a click outside leaves the group');
// double-click a grouped text: edits it
const pa = await onA();
await page.mouse.dblclick(pa.x, pa.y);
check(await page.isVisible('textarea.text-edit'), 'double-click on a grouped text edits it');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await click(await S(0, 70));

// ---- Overlapping lines: click again to go through the pile ----
const spot = await S(0, -30);
await click(spot);
check(await sel() === 'L1' && /1 of 3 here/.test(await hint()), `first click: the top line, "1 of 3 here" (${await sel()} · ${await hint()})`);
await click(spot);
check(await sel() === 'L2' && /2 of 3/.test(await hint()), `click again: the next one (${await sel()})`);
await click(spot);
check(await sel() === 'L3' && /3 of 3/.test(await hint()), `then the one on the other layer (${await sel()})`);
await click(spot);
check(await sel() === 'L1', 'and round again');
await click(spot);                                                     // L2 selected
const l2 = () => page.evaluate(() => { const l = window._app.activeSketch().entities.find(e => e.id === 'L2'); return [l.p1.y, l.p2.y]; });
const l1 = () => page.evaluate(() => { const l = window._app.activeSketch().entities.find(e => e.id === 'L1'); return [l.p1.y, l.p2.y]; });
const before1 = await l1();
await drag(spot, 0, -50);
const after2 = await l2(), after1 = await l1();
check(after2[0] > -25 && JSON.stringify(after1) === JSON.stringify(before1), `pressing on the selected lower line drags that one, not the top one (L2 y ${after2[0].toFixed(1)})`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);

// ---- Right-click lists the pile ----
await click(await S(0, 70));
await click(spot);                                                     // L1
await page.mouse.click(spot.x, spot.y, { button: 'right' });
await page.waitForSelector('#context-menu');
const rows = await page.evaluate(() => [...document.querySelectorAll('#context-menu .context-menu-item:not(.action)')].map(r => r.textContent.replace(/\s+/g, ' ').trim()));
check(/Also here/.test(await page.textContent('#context-menu')) && rows.some(r => /L2/.test(r)) && rows.some(r => /L3.*Back|Back.*L3/.test(r)), `right-click on the selected line lists the others there, other layers tagged (${rows.join(' | ')})`);
await page.click('#context-menu .context-menu-item:has-text("L3")');
check(await sel() === 'L3', 'picking one in the list selects it');
await page.keyboard.press('Escape');
// right-click a whole selected group: "this one only"
await click(await onA());
const pb = await onB();
await page.mouse.click(pb.x, pb.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="select-member"]');
await page.click('#context-menu [data-action="select-member"]');
check(await sel() === 'tB', 'right-click a group member → "Select this text only"');
await page.mouse.click(pb.x, pb.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="select-group"]');
check(/1 of 2 in a group/.test(await page.textContent('#context-menu')), 'inside a group the menu says "1 of 2 in a group"');
await page.click('#context-menu [data-action="select-group"]');
check(await sel() === 'tA,tB', '"Select the whole group"');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

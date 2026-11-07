// End-to-end smoke test: drives the editor in headless Chromium.
// Usage: node tests/smoke.e2e.mjs [rootDir] [screenshotPath]
// Starts a static server on rootDir (default: repo root) and opens /app/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const shot = process.argv[3] || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

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

await page.addInitScript(() => { try { localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); } catch {} });
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

// Rectangle
await page.keyboard.press('r');
await page.mouse.click(cx - 200, cy - 100);
await page.mouse.click(cx - 40, cy + 60);
// Circle
await page.keyboard.press('c');
await page.mouse.click(cx + 150, cy);
await page.mouse.click(cx + 220, cy);
// Line chain
await page.keyboard.press('l');
await page.mouse.click(cx - 100, cy + 200);
await page.mouse.click(cx + 100, cy + 230);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.keyboard.press('s');

let info = await page.evaluate(() => {
  const s = window._app.activeSketch();
  return { ents: s.entities.length, cons: s.constraints.length, kinds: s.entities.map(e => e.constructor.kind) };
});
check(info.ents >= 6, `drew entities (${info.ents}: ${info.kinds.join(',')})`);
check(info.cons >= 4, `rectangle added constraints (${info.cons})`);

// Select the free line and make it horizontal through the relations API.
const horiz = await page.evaluate(() => {
  const a = window._app, s = a.activeSketch();
  const line = s.entities.filter(e => e.constructor.kind === 'line').pop();
  a.clearSelection(); a.setSelected(line, true);
  a.applyConstraint('horizontal');
  return Math.abs(line.p1.y - line.p2.y);
});
check(horiz < 1e-6, `horizontal constraint solved (dy=${horiz})`);

// Radius dimension on the circle: sidebar route, then click to place and type a value.
await page.evaluate(() => {
  const a = window._app, s = a.activeSketch();
  const c = s.entities.find(e => e.constructor.kind === 'circle');
  a.clearSelection(); a.setSelected(c, true);
  a.applyDimension('radius');
});
await page.mouse.move(cx + 260, cy - 80);
await page.mouse.click(cx + 260, cy - 80);
const input = page.locator('#workspace > input');
if (await input.count()) { await input.fill('12.5'); await input.press('Enter'); }
const rad = await page.evaluate(() => {
  const s = window._app.activeSketch();
  return s.entities.find(e => e.constructor.kind === 'circle').r;
});
check(Math.abs(rad - 12.5) < 1e-6, `radius dimension drives circle (r=${rad})`);
await page.keyboard.press('Escape');
await page.keyboard.press('s');

// Undo / redo round trip.
const undo = await page.evaluate(() => {
  const a = window._app;
  const n0 = a.activeSketch().constraints.length;
  a.undo(); const n1 = a.activeSketch().constraints.length;
  a.redo(); const n2 = a.activeSketch().constraints.length;
  return { n0, n1, n2 };
});
check(undo.n1 < undo.n0 && undo.n2 === undo.n0, `undo/redo (${undo.n0} -> ${undo.n1} -> ${undo.n2})`);

// Drag a rectangle corner with the mouse.
const before = await page.evaluate(() => JSON.stringify(window._app.project.toJSON()));
await page.mouse.move(cx - 200, cy - 100);
await page.mouse.down();
await page.mouse.move(cx - 230, cy - 130, { steps: 5 });
await page.mouse.up();
const after = await page.evaluate(() => JSON.stringify(window._app.project.toJSON()));
check(before !== after, 'drag moved geometry');

// Status + DOF pills populated.
const status = await page.evaluate(() => [document.getElementById('status-state').textContent, document.getElementById('status-dof').textContent]);
check(/DOF/.test(status[1]), `status bar (${status.join(' | ')})`);

// JSON round-trip.
const rt = await page.evaluate(() => {
  const a = window._app; const j = JSON.stringify(a.project.toJSON());
  const P = a.project.constructor; const j2 = JSON.stringify(P.fromJSON(JSON.parse(j)).toJSON());
  return j === j2;
});
check(rt, 'project JSON round-trips');

// ---- Layers, styles, fills ----
await page.click('#layer-add');
const layerInfo = await page.evaluate(() => {
  const a = window._app;
  return { n: a.project.layers.length, active: a.project.activeLayer().name, rows: document.querySelectorAll('#layer-list .lyr-row').length };
});
check(layerInfo.n === 2 && layerInfo.rows === 2 && layerInfo.active === 'Layer 2', `add layer (${JSON.stringify(layerInfo)})`);

// New shapes: no fill at creation, line colour from state only.
await page.evaluate(() => window._app.clearSelection());
await page.click('.palette .sw[data-c="#e07b00"]');            // fill colour, for the Fill tool only
await page.keyboard.press('r');
await page.mouse.click(cx + 60, cy + 60);
await page.mouse.click(cx + 200, cy + 160);
await page.keyboard.press('Escape');
await page.keyboard.press('s');
const onLayer2 = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  const ents = a.project.entitiesOnLayer(ly.id);
  const t = a.renderer.theme;
  return { count: ents.length, style: ents[0]?.style, fills: a.activeSketch().fills.length,
    stateColour: [t.under, t.fully, t.over].includes(a.renderer.styleFor(ents[0], true).color) };
});
check(onLayer2.count === 4 && !('color' in (onLayer2.style || {})) && !('fill' in (onLayer2.style || {})) && onLayer2.fills === 0 && onLayer2.stateColour,
  `new shapes: no fill, colour from state (${JSON.stringify(onLayer2)})`);

const pixel = (x, y) => page.evaluate(async ([x, y]) => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.getElementById('canvas'), r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  return Array.from(c.getContext('2d').getImageData((x - r.left) * d, (y - r.top) * d, 1, 1).data);
}, [x, y]);
const empty = await pixel(cx + 130, cy + 110);
check(empty[3] === 0, `nothing filled at creation (rgba ${empty.join(',')})`);

// Fill tool on overlapping shapes fills just the clicked area.
await page.keyboard.press('r');
await page.mouse.click(cx + 150, cy + 100);
await page.mouse.click(cx + 270, cy + 210);
await page.keyboard.press('Escape');
await page.keyboard.press('b');
const cursor = await page.evaluate(() => document.getElementById('canvas').style.cursor);
check(/^url\("data:image\/svg\+xml/.test(cursor) && cursor.includes(encodeURIComponent('#e07b00')), 'fill tool shows a fill cursor in the fill colour');
await page.mouse.click(cx + 175, cy + 130);
const overlapPx = await pixel(cx + 175, cy + 130);
const soloPx = await pixel(cx + 95, cy + 145);   // off the grid lines (every 40px here)
check(overlapPx[3] > 0 && soloPx[3] === 0, `fill tool fills only the clicked area (overlap ${overlapPx.join(',')}, rest ${soloPx.join(',')})`);
await page.evaluate(() => window._app.undo());
await page.keyboard.press('s');

// Line style changes never touch existing geometry; "Apply line style" does.
await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  a.clearSelection();
  a.setSelected(a.project.entitiesOnLayer(ly.id)[0], true);
  a.refreshUI();
});
await page.evaluate(() => window._app._setPen('lineStyle', 'center', true));
const untouched = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  return a.project.entitiesOnLayer(ly.id)[0].style;
});
check(untouched.lineStyle !== 'center', `pen changes leave the selection alone (${JSON.stringify(untouched)})`);
await page.click('#optbar [data-opt="apply-style"]');
const ov = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  return a.project.entitiesOnLayer(ly.id)[0].style;
});
check(ov && ov.lineStyle === 'center', `apply line style (${JSON.stringify(ov)})`);
const undoStyle = await page.evaluate(() => {
  const a = window._app; a.undo();
  const ly = a.project.activeLayer();
  return a.project.entitiesOnLayer(ly.id)[0].style;
});
check(undoStyle && undoStyle.lineStyle !== 'center', `style change is undoable (${JSON.stringify(undoStyle)})`);
await page.evaluate(() => window._app._setPen('lineStyle', 'solid', true));

// Only the active layer is pickable.
const activeOnly = await page.evaluate(() => {
  const a = window._app, other = a.project.layers[0];
  const c = a.project.entitiesOnLayer(other.id).find(e => e.constructor.kind === 'circle');
  const at = { x: c.center.x + c.r, y: c.center.y };
  const whileOther = a.hitTestAcrossLayers(at);
  const keep = a.project.activeLayerId;
  a.project.activeLayerId = other.id;
  const whileOwn = a.hitTestAcrossLayers(at);
  a.project.activeLayerId = keep;
  return { other: whileOther === null, own: whileOwn === c };
});
check(activeOnly.other && activeOnly.own, `picking limited to the active layer (${JSON.stringify(activeOnly)})`);

// Hidden layers can't be picked or snapped to.
const hideHit = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  const line = a.project.entitiesOnLayer(ly.id)[0];
  const mid = { x: (line.p1.x + line.p2.x) / 2, y: (line.p1.y + line.p2.y) / 2 };
  const before = a.hitTestAcrossLayers(mid) === line;
  ly.visible = false;
  const hidden = a.hitTestAcrossLayers(mid);
  const snap = a.snap.find(line.p1, a.view, a.visibleSketches());
  ly.visible = true;
  return { before, hidden: hidden === null, snapHidden: !snap || snap.entity !== line.p1 };
});
check(hideHit.before && hideHit.hidden && hideHit.snapHidden, `hidden layers excluded from picking and snapping (${JSON.stringify(hideHit)})`);

// Inactive layers stay put while a connected line on the active layer is dragged.
const lockDrag = await page.evaluate(() => {
  const a = window._app, base = a.project.layers[0];
  const rectLine = a.project.entitiesOnLayer(base.id).find(e => e.constructor.kind === 'line');
  a.project.activeLayerId = a.project.layers[1].id;
  const tool = a.tool; a.setTool('line');
  return { id: rectLine.id, p: [rectLine.p2.x, rectLine.p2.y], baseId: base.id, tool: !!tool };
});
// draw a line starting on the (inactive) rectangle's corner
await page.evaluate(() => { const a = window._app; a.commit(); a.refreshUI(); });
const corner = await page.evaluate((id) => {
  const a = window._app, l = a.project.sketches[0].entities.find(e => e.id === id);
  return a.view.worldToScreen(l.p2);
}, lockDrag.id);
await page.mouse.click(box.x + corner.x, box.y + corner.y);
await page.mouse.click(box.x + corner.x + 80, box.y + corner.y + 90);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('s');
const end = await page.evaluate(() => { const s = window._app.activeSketch(); const l = s.entities[s.entities.length - 1]; return window._app.view.worldToScreen(l.p2); });
await page.mouse.move(box.x + end.x, box.y + end.y);
await page.mouse.down();
await page.mouse.move(box.x + end.x - 120, box.y + end.y + 40, { steps: 6 });
await page.mouse.up();
const after2 = await page.evaluate((id) => {
  const a = window._app, l = a.project.sketches[0].entities.find(e => e.id === id);
  const last = a.activeSketch().entities[a.activeSketch().entities.length - 1];
  return { p: [l.p2.x, l.p2.y], shared: last.p1 === l.p2 || a.activeSketch().constraints.some(c => c.kind === 'coincident') };
}, lockDrag.id);
check(after2.p[0] === lockDrag.p[0] && after2.p[1] === lockDrag.p[1], `inactive layer did not move during drag (${JSON.stringify({ before: lockDrag.p, after: after2 })})`);

// Fill tool is blind to other layers: with Layer 2 active, clicking inside
// Layer 1's rectangle finds no region there, so it fills the background.
await page.evaluate(() => window._app._setPen('lineStyle', 'solid', true));
await page.click('.palette .sw[data-c="#8a4fd1"]', { button: 'right' });
await page.keyboard.press('b');
await page.mouse.click(cx - 120, cy - 20);
const blind = await page.evaluate(() => ({ fills: window._app.activeSketch().fills.length, bg: window._app.project.background }));
check(blind.fills === 0 && blind.bg === '#8a4fd1', `fill ignores other layers' shapes (${JSON.stringify(blind)})`);
await page.evaluate(() => window._app.undo());

// On Layer 1 the same click fills its rectangle; then background; then erase.
await page.click('#layer-list .lyr-row:last-child');
await page.keyboard.press('b');
await page.mouse.click(cx - 120, cy - 20);
const bucket = await page.evaluate(() => {
  const a = window._app, s = a.activeSketch();
  return { fills: s.fills.map(f => ({ layer: f.layerId === a.project.activeLayerId, color: f.color, n: f.ids.length })) };
});
check(bucket.fills.length === 1 && bucket.fills[0].layer && bucket.fills[0].color === '#8a4fd1' && bucket.fills[0].n >= 4,
  `fill tool fills the clicked region (${JSON.stringify(bucket)})`);
const bucketPx = await pixel(cx - 120, cy - 20);
check(bucketPx[3] > 0 && bucketPx[2] > bucketPx[1], `region fill painted (rgba ${bucketPx.join(',')})`);
const holePx = await pixel(cx + 200, cy - 220);
await page.mouse.click(cx + 200, cy - 220);
const bg = await page.evaluate(() => window._app.project.background);
check(bg === '#8a4fd1', `click outside regions fills the background (${bg})`);
const bgUndo = await page.evaluate(() => { const a = window._app; a.undo(); return a.project.background; });
check(bgUndo === null, 'background fill is undoable');
await page.evaluate(() => window._app.redo());
await page.click('#optbar [data-opt="erase-mode"]');
await page.mouse.click(cx - 120, cy - 20);
await page.mouse.click(cx + 200, cy - 220);
const erased = await page.evaluate(() => ({ fills: window._app.activeSketch().fills.length, bg: window._app.project.background }));
check(erased.fills === 0 && erased.bg === null, `erase removes fills and background (${JSON.stringify(erased)})`);
await page.click('#optbar [data-opt="fill-mode"]');
await page.mouse.click(cx - 120, cy - 20);
await page.keyboard.press('s');
void holePx;

// Dimensions can be hidden and shown; Smart Dimension brings them back.
await page.click('#menubar [data-action="dimensions"]');
const dimsHidden = await page.evaluate(() => ({ show: window._app.showDimensions, rects: window._app.renderer.lastDimRects.length }));
await page.keyboard.press('d');
const dimsBack = await page.evaluate(() => window._app.showDimensions);
await page.keyboard.press('Escape'); await page.keyboard.press('s');
check(!dimsHidden.show && dimsHidden.rects === 0 && dimsBack, `dimension visibility toggle (${JSON.stringify({ dimsHidden, dimsBack })})`);

// Floating windows close and reopen from the menu bar.
await page.click('.fwin[data-win="layers"] .fwin-x');
const closed = await page.evaluate(() => document.querySelector('.fwin[data-win="layers"]').hidden);
await page.click('#menubar [data-window="layers"]');
const reopened = await page.evaluate(() => !document.querySelector('.fwin[data-win="layers"]').hidden);
check(closed && reopened, 'floating window close / reopen');

// Fill tool on two rectangles drawn to share a side (B starts on A's corner).
await page.click('#layer-add');
await page.keyboard.press('r');
await page.mouse.click(cx - 330, cy + 150);
await page.mouse.click(cx - 250, cy + 230);
await page.mouse.move(cx - 250, cy + 150, { steps: 3 });
await page.mouse.click(cx - 250, cy + 150);
await page.mouse.click(cx - 170, cy + 230);
await page.keyboard.press('Escape');
await page.click('.palette .sw[data-c="#14946b"]', { button: 'right' });
await page.keyboard.press('b');
await page.mouse.click(cx - 290, cy + 190);
await page.click('.palette .sw[data-c="#c2307a"]', { button: 'right' });
await page.mouse.click(cx - 210, cy + 190);
await page.keyboard.press('s');
const shared = await page.evaluate(() => {
  const a = window._app, s = a.activeSketch(), ly = a.project.activeLayerId;
  return { fills: s.fills.filter(f => f.layerId === ly).map(f => f.color), ents: a.project.entitiesOnLayer(ly).length };
});
const pa = await pixel(cx - 295, cy + 185), pb = await pixel(cx - 205, cy + 185);
check(shared.fills.length === 2 && pa[3] > 0 && pb[3] > 0 && pa[1] > pa[0] && pb[0] > pb[1],
  `fill tool on shapes sharing a side (${JSON.stringify(shared)} left ${pa.join(',')} right ${pb.join(',')})`);

// Units and equations in dimensions.
await page.click('#layer-add');
await page.keyboard.press('l');
await page.mouse.click(cx + 120, cy - 300);
await page.mouse.click(cx + 260, cy - 300);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
await page.keyboard.press('d');
await page.mouse.click(cx + 190, cy - 300);
await page.mouse.click(cx + 190, cy - 330);
await page.locator('#workspace > input.dim-input').fill('1in');
await page.keyboard.press('Enter');
const inch = await page.evaluate(() => {
  const a = window._app, c = a.activeSketch().constraints.filter(k => k.kind === 'distance').pop();
  const l = a.activeSketch().entities.filter(e => e.constructor.kind === 'line').pop();
  return { name: c.name, value: c.value, len: Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y) };
});
check(Math.abs(inch.value - 25.4) < 1e-9 && Math.abs(inch.len - 25.4) < 1e-6, `typing 1in makes a 25.4 mm dimension (${JSON.stringify(inch)})`);

await page.keyboard.press('c');
await page.mouse.click(cx + 200, cy - 200);
await page.mouse.click(cx + 220, cy - 200);
await page.keyboard.press('d');
await page.mouse.click(cx + 220, cy - 200);
await page.mouse.click(cx + 260, cy - 240);
await page.locator('#workspace > input.dim-input').fill(`=${inch.name}/2 + 5mm`);
await page.keyboard.press('Enter');
const eq = await page.evaluate(() => {
  const a = window._app, c = a.activeSketch().constraints.filter(k => k.kind === 'radius').pop();
  return { id: c.id, name: c.name, expr: c.expr, dia: c.isDiameter ? c.value * 2 : c.value };
});
check(eq.expr && Math.abs(eq.dia - 17.7) < 1e-9, `formula drives a dimension (${JSON.stringify(eq)})`);

// Changing the referenced dimension updates the formula-driven one.
await page.evaluate((nm) => {
  const a = window._app, c = a.activeSketch().constraints.find(k => k.name === nm);
  a.setDimensionFromText(c, '2in');
}, inch.name);
const eq2 = await page.evaluate((id) => {
  const c = window._app.activeSketch().constraints.find(k => k.id === id);
  return c.isDiameter ? c.value * 2 : c.value;
}, eq.id);
check(Math.abs(eq2 - 30.4) < 1e-9, `formula follows the dimension it uses (${eq2})`);

// Re-editing shows the formula, not the value.
await page.keyboard.press('s');
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
await page.evaluate((id) => { const a = window._app; a.editDimValue(a.activeSketch().constraints.find(k => k.id === id)); }, eq.id);
const editText = await page.locator('#workspace > input.dim-input').inputValue();
await page.keyboard.press('Escape');
check(editText === `=${inch.name}/2 + 5mm`, `editing shows the formula (${editText})`);

// Bad formula keeps the box open and flags it.
await page.evaluate((id) => { const a = window._app; a.editDimValue(a.activeSketch().constraints.find(k => k.id === id)); }, eq.id);
await page.locator('#workspace > input.dim-input').fill('=nope*2');
await page.keyboard.press('Enter');
const bad = await page.evaluate(() => { const i = document.querySelector('#workspace > input.dim-input'); return i && i.classList.contains('bad') ? i.title : null; });
await page.keyboard.press('Escape');
check(bad && /Unknown name/.test(bad), `bad formula is flagged (${bad})`);

// Only the active layer is highlighted; no lock controls anywhere.
const layerUi = await page.evaluate(() => ({
  active: document.querySelectorAll('#layer-list .lyr-row.active').length,
  lockButtons: document.querySelectorAll('#layer-list [data-k="lock"], #lock-banner, .lock-tag').length,
  activeName: document.querySelector('#layer-list .lyr-row.active .name').textContent,
  current: window._app.project.activeLayer().name,
}));
check(layerUi.active === 1 && layerUi.lockButtons === 0 && layerUi.activeName === layerUi.current, `active layer highlighted, no lock UI (${JSON.stringify(layerUi)})`);

// Dropping a dragged point on a snap target: a free point connects; a
// fully defined point stays put and no conflicting constraint is added.
const dropSetup = await page.evaluate(() => {
  const a = window._app;
  const P = a.project.constructor;
  a.project = P.fromJSON({ version: 3, layers: [{ id: 'ly1', name: 'L' }], activeLayerId: 'ly1', sketches: [{ id: 's1', name: 'S', entities: [
    { type: 'line', id: 'e3', layerId: 'ly1', p1: { type: 'point', id: 'e1', x: 0, y: 0, fixed: true }, p2: { type: 'point', id: 'e2', x: 40, y: 0 } },
    { type: 'line', id: 'e5', layerId: 'ly1', p1: { type: 'point', id: 'e2', x: 40, y: 0 }, p2: { type: 'point', id: 'e4', x: 40, y: 20 } },
    { type: 'line', id: 'e8', layerId: 'ly1', p1: { type: 'point', id: 'e6', x: -30, y: -20 }, p2: { type: 'point', id: 'e7', x: -10, y: -20 } }],
    constraints: [
      { id: 'c9', kind: 'fix', pointId: 'e1', x: 0, y: 0 },
      { id: 'c10', kind: 'horizontal', lineId: 'e3', p1: 'e1', p2: 'e2' },
      { id: 'c11', kind: 'vertical', lineId: 'e5', p1: 'e2', p2: 'e4' },
      { id: 'c12', kind: 'distance', p1: 'e1', p2: 'e2', value: 40 },
      { id: 'c13', kind: 'distance', p1: 'e2', p2: 'e4', value: 20 }] }] });
  a._afterStateSwap(); a.view.zoom = 4; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' });
  const s = a.activeSketch(); const pt = (id) => { for (const e of s.entities) for (const c of e.children()) if (c.id === id) return c; };
  const scr = (id) => a.view.worldToScreen(pt(id));
  return { e4: scr('e4'), e7: scr('e7'), e1: scr('e1'), n: s.constraints.length };
});
await page.keyboard.press('s');
const dragTo = async (from, to) => {
  await page.mouse.move(box.x + from.x, box.y + from.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + from.x + (to.x - from.x) * i / 10, box.y + from.y + (to.y - from.y) * i / 10);
  await page.mouse.up();
};
await dragTo(dropSetup.e4, dropSetup.e7);          // fully defined corner onto the free line's end
const held = await page.evaluate(() => {
  const s = window._app.activeSketch(); const pts = {};
  for (const e of s.entities) for (const c of e.children()) pts[c.id] = [+c.x.toFixed(6), +c.y.toFixed(6)];
  return { pts, n: s.constraints.length, state: document.getElementById('status-state').textContent };
});
check(held.n === dropSetup.n && held.pts.e4[0] === 40 && held.pts.e4[1] === 20 && held.pts.e1[0] === 0 && held.pts.e1[1] === 0,
  `fully defined point dropped on a target: unchanged, nothing added (${JSON.stringify(held)})`);
await dragTo(dropSetup.e7, dropSetup.e4);          // free end onto the corner
const joined = await page.evaluate(() => {
  const s = window._app.activeSketch();
  return { coincident: s.constraints.some(c => c.kind === 'coincident' && [c.p1, c.p2].sort().join() === 'e4,e7'),
    e7: (() => { const l = s.entities.find(e => e.id === 'e8'); return [+l.p2.x.toFixed(6), +l.p2.y.toFixed(6)]; })() };
});
check(joined.coincident && joined.e7[0] === 40 && joined.e7[1] === 20, `free point dropped on a target connects (${JSON.stringify(joined)})`);

// A global variable drives dimensions on every layer, not just the active one.
await page.evaluate(() => {
  const a = window._app, P = a.project.constructor;
  const pt = (id, x, y, fixed = false) => ({ type: 'point', id, x, y, fixed });
  a.project = P.fromJSON({ version: 3, activeLayerId: 'ly2', variables: [{ name: 'w', expr: '40' }],
    layers: [{ id: 'ly1', name: 'Base' }, { id: 'ly2', name: 'Top' }],
    sketches: [{ id: 's1', name: 'S', entities: [
      { type: 'line', id: 'e3', layerId: 'ly1', p1: pt('e1', 0, 0, true), p2: pt('e2', 40, 0) },
      { type: 'circle', id: 'e5', layerId: 'ly2', center: pt('e4', 0, 30, true), r: 10 }],
    constraints: [
      { id: 'c6', kind: 'fix', pointId: 'e1', x: 0, y: 0 },
      { id: 'c7', kind: 'horizontal', lineId: 'e3', p1: 'e1', p2: 'e2' },
      { id: 'c8', kind: 'distance', p1: 'e1', p2: 'e2', value: 40, name: 'D1', expr: 'w' },
      { id: 'c9', kind: 'fix', pointId: 'e4', x: 0, y: 30 },
      { id: 'c10', kind: 'radius', circleId: 'e5', value: 10, isDiameter: true, name: 'D2', expr: 'w/2' }] }] });
  a._afterStateSwap(); a.commit({ diagnostics: 'sync' });
  if (a.windows && !a.windows.isOpen('equations')) a.windows.toggle('equations', true);
  a._refreshEquationsPanel();
});
const varInput = page.locator('#equations-body input[data-k="var-expr"]').first();
await varInput.fill('3in');
await varInput.press('Tab');
const allLayers = await page.evaluate(() => {
  const a = window._app, s = a.activeSketch();
  const l = s.entities.find(e => e.id === 'e3'), c = s.entities.find(e => e.id === 'e5');
  return { active: a.project.activeLayer().name, len: Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y), dia: c.r * 2 };
});
check(allLayers.active === 'Top' && Math.abs(allLayers.len - 76.2) < 1e-6 && Math.abs(allLayers.dia - 38.1) < 1e-6,
  `variable change updates every layer (${JSON.stringify(allLayers)})`);
const undone = await page.evaluate(() => {
  const a = window._app; a.undo();
  const s = a.activeSketch(), l = s.entities.find(e => e.id === 'e3'), c = s.entities.find(e => e.id === 'e5');
  return { len: Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y), dia: c.r * 2 };
});
check(Math.abs(undone.len - 40) < 1e-6 && Math.abs(undone.dia - 20) < 1e-6, `undo restores every layer (${JSON.stringify(undone)})`);

// Colour mode + theme toggles (end in Colors mode for the screenshot).
await page.click('#menubar [data-action="theme"]');
const prefs = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme }));
check(prefs.theme === 'dark', `theme toggle (${JSON.stringify(prefs)})`);
// Editing a dimension in dark mode: the input text must be readable.
await page.keyboard.press('s');
const dimRect = await page.evaluate(() => { const r = window._app.renderer.lastDimRects[0]; return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 }; });
let dimInput = null;
if (dimRect) {
  await page.mouse.dblclick(box.x + dimRect.x, box.y + dimRect.y);
  const inp = page.locator('#workspace > input');
  if (await inp.count()) {
    dimInput = await inp.evaluate(el => { const cs = getComputedStyle(el); return { color: cs.color, bg: cs.backgroundColor }; });
    await inp.press('Escape');
  }
}
check(dimInput && dimInput.color !== dimInput.bg && !/255, 255, 255/.test(dimInput.bg), `dimension edit box readable in dark mode (${JSON.stringify(dimInput)})`);

// A point on a fixed-length arm, dragged over points / lines it can't
// reach: it keeps following the cursor round its circle, no snap is shown
// unless the point is really on it, and release adds no constraint.
const arm = await page.evaluate(() => {
  const a = window._app, P = a.project.constructor;
  const pt = (id, x, y, fixed = false) => ({ type: 'point', id, x, y, fixed });
  a.project = P.fromJSON({ version: 3, layers: [{ id: 'ly1', name: 'L' }], activeLayerId: 'ly1', sketches: [{ id: 's1', name: 'S', entities: [
    { type: 'line', id: 'e3', layerId: 'ly1', p1: pt('e1', 0, 0, true), p2: pt('e2', 0, 50, true) },
    { type: 'line', id: 'e6', layerId: 'ly1', p1: pt('e4', -60, 50, true), p2: pt('e5', -44, 38) }],
    constraints: [
      { id: 'c7', kind: 'fix', pointId: 'e1', x: 0, y: 0 }, { id: 'c8', kind: 'fix', pointId: 'e2', x: 0, y: 50 },
      { id: 'c9', kind: 'fix', pointId: 'e4', x: -60, y: 50 },
      { id: 'c10', kind: 'distance', p1: 'e4', p2: 'e5', value: 20 }] }] });
  a._afterStateSwap(); a.view.zoom = 5; a.view.panX = 150; a.view.panY = 175; a.commit({ diagnostics: 'sync' });
  if (a.windows) a.windows.toggle('equations', false);
  return { n: a.activeSketch().constraints.length };
});
await page.keyboard.press('s');
const W = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]);
const startPt = await W(-44, 38);
await page.mouse.move(box.x + startPt.x, box.y + startPt.y); await page.mouse.down();
let worstGap = 0, worstOff = 0, cur = [-44, 38];
const offs = [];
for (const [tx, ty] of [[-20, 48], [0, 50], [0, 30], [-2, 10], [0, 0], [-30, 20], [-55, 70]]) {
  for (let i = 1; i <= 6; i++) {
    const wx = cur[0] + (tx - cur[0]) * i / 6, wy = cur[1] + (ty - cur[1]) * i / 6;
    const sp = await W(wx, wy);
    await page.mouse.move(box.x + sp.x, box.y + sp.y);
    const f = await page.evaluate(([wx, wy]) => {
      const a = window._app, l = a.activeSketch().entities.find(e => e.id === 'e6');
      const gaps = (a.lastDragSnaps || []).map(k => Math.hypot(l.p2.x - k.x, l.p2.y - k.y) * a.view.zoom);
      const vx = wx + 60, vy = wy - 50, L = Math.hypot(vx, vy);
      return { gap: Math.max(0, ...gaps), off: Math.hypot(l.p2.x - (-60 + 20 * vx / L), l.p2.y - (50 + 20 * vy / L)) };
    }, [wx, wy]);
    worstGap = Math.max(worstGap, f.gap); worstOff = Math.max(worstOff, f.off); offs.push(f.off);
  }
  cur = [tx, ty];
}
await page.mouse.up();
const armAfter = await page.evaluate(() => window._app.activeSketch().constraints.length);
check(worstGap <= 3, `no snap shown away from the dragged point (worst ${worstGap.toFixed(2)} px)`);
offs.sort((x, y) => x - y);
const medianOff = offs[offs.length >> 1];
check(worstOff < 1.5 && medianOff < 0.1, `point on a fixed arm follows the cursor round its circle (median ${medianOff.toFixed(3)} mm, worst ${worstOff.toFixed(3)} mm off)`);
check(armAfter === arm.n, `release over an unreachable target adds nothing (${arm.n} → ${armAfter})`);

await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
if (shot) await page.screenshot({ path: shot });
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);

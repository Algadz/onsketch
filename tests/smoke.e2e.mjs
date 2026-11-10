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
const nativeDialogs = [];
page.on('dialog', d => { nativeDialogs.push(`${d.type()}: ${d.message()}`); d.dismiss(); });
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
await page.click('#colors-body .palette .sw[data-c="#e07b00"]');            // the colour, used by Fill / Pen / Marker only
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
await page.keyboard.press('s');
const selBar = await page.evaluate(() => ({ buttons: document.querySelectorAll('#optbar button').length, hint: !!document.querySelector('#optbar .opt-hint') }));
check(selBar.buttons === 0 && selBar.hint, `Select options bar: just the hint (${JSON.stringify(selBar)})`);
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
await page.keyboard.press('b');
await page.click('#colors-body .palette .sw[data-c="#8a4fd1"]');
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
  return { fills: s.fills.map(f => ({ layer: f.layerId === a.project.activeLayerId, color: f.color, painted: !!f.region })) };
});
check(bucket.fills.length === 1 && bucket.fills[0].layer && bucket.fills[0].color === '#8a4fd1' && bucket.fills[0].painted,
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
await page.keyboard.press('b');
await page.click('#colors-body .palette .sw[data-c="#14946b"]');
await page.mouse.click(cx - 290, cy + 190);
await page.click('#colors-body .palette .sw[data-c="#c2307a"]');
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
await page.evaluate(async () => { const a = window._app; a.windows.toggle('equations', false); a.requestRender(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
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

// Fill colours follow the areas: merge on release, undo, opened areas.
const fillScene = await page.evaluate(() => {
  const a = window._app, P = a.project.constructor;
  const pt = (id, x, y, fixed = false) => ({ type: 'point', id, x, y, fixed });
  a.project = P.fromJSON({ version: 3, layers: [{ id: 'ly1', name: 'L' }], activeLayerId: 'ly1', sketches: [{ id: 's1', name: 'S', entities: [
    { type: 'line', id: 'e5', layerId: 'ly1', p1: pt('e1', 0, 0, true), p2: pt('e2', 60, 0, true) },
    { type: 'line', id: 'e6', layerId: 'ly1', p1: pt('e2', 60, 0, true), p2: pt('e3', 60, 40, true) },
    { type: 'line', id: 'e7', layerId: 'ly1', p1: pt('e3', 60, 40, true), p2: pt('e4', 0, 40, true) },
    { type: 'line', id: 'e8', layerId: 'ly1', p1: pt('e4', 0, 40, true), p2: pt('e1', 0, 0, true) },
    { type: 'line', id: 'e10', layerId: 'ly1', p1: pt('e4', 0, 40, true), p2: pt('e9', 75, -20) },   // crosses the bottom at x=50
    // an open-able triangle: its last side ends on the base (no shared point)
    { type: 'line', id: 'e13', layerId: 'ly1', p1: pt('e11', 86, 0, true), p2: pt('e12', 110, 0, true) },
    { type: 'line', id: 'e15', layerId: 'ly1', p1: pt('e12', 110, 0, true), p2: pt('e14', 100, 20, true) },
    { type: 'line', id: 'e17', layerId: 'ly1', p1: pt('e14', 100, 20, true), p2: pt('e16', 92, 0) }],
    constraints: [],
    fills: [{ id: 'f20', layerId: 'ly1', color: '#14946b', opacity: 1, seed: { x: 50, y: 30 } },
            { id: 'f21', layerId: 'ly1', color: '#c9a400', opacity: 1, seed: { x: 10, y: 10 } },
            { id: 'f22', layerId: 'ly1', color: '#8a4fd1', opacity: 1, seed: { x: 100, y: 7 } }] }] });
  a._afterStateSwap(); a.view.zoom = 4; a.view.panX = -180; a.view.panY = 60; a.commit({ diagnostics: 'sync' });
  for (const w of ['equations', 'props', 'colors']) a.windows.toggle(w, false);
  return a.activeSketch().fills.map(f => f.color).sort().join(',');
});
check(fillScene === '#14946b,#8a4fd1,#c9a400', `fill scene loads with three painted areas (${fillScene})`);
await page.keyboard.press('s');
const drag2 = async (from, to, holdCheck) => {
  const A = await W(from[0], from[1]), B = await W(to[0], to[1]);
  await page.mouse.move(box.x + A.x, box.y + A.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + A.x + (B.x - A.x) * i / 10, box.y + A.y + (B.y - A.y) * i / 10);
  const during = holdCheck ? await page.evaluate(() => { const d = [...window._app.fillDisplay().values()][0]; return { painted: d.painted.length }; }) : null;
  await page.mouse.up();
  return during;
};
await drag2([75, -20], [40, 20]);          // diagonal end inside the rectangle: no longer splits it
const merged = await page.evaluate(() => window._app.activeSketch().fills.map(f => f.color));
check(merged.length === 2 && merged.includes('#14946b') && !merged.includes('#c9a400'),
  `merge on release keeps the majority colour, green 1400 mm² over yellow 1000 mm² (${merged.join(',')})`);
const unmerged = await page.evaluate(() => { const a = window._app; a.undo(); return a.activeSketch().fills.map(f => f.color).sort().join(','); });
check(unmerged === '#14946b,#8a4fd1,#c9a400', `undo brings both colours back (${unmerged})`);
// Open the triangle (its side now passes left of the base): its paint is
// gone from the display while dragging and removed on release; undo restores it.
const openDuring = await drag2([92, 0], [70, -15], true);
const afterOpen = await page.evaluate(() => window._app.activeSketch().fills.map(f => f.color).sort().join(','));
const undoOpen = await page.evaluate(() => { const a = window._app; a.undo(); return a.activeSketch().fills.map(f => f.color).sort().join(','); });
check(openDuring.painted === 2 && afterOpen === '#14946b,#c9a400' && undoOpen === '#14946b,#8a4fd1,#c9a400',
  `opened area: paint removed on release, undo restores it (${JSON.stringify({ openDuring, afterOpen, undoOpen })})`);
await page.keyboard.press('s');

// Dimensions belong to a layer; status colours are per layer.
await page.evaluate(() => {
  const a = window._app, P = a.project.constructor;
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  a.project = P.fromJSON({ version: 3, activeLayerId: 'ly1', variables: [{ name: 'w', expr: '40' }],
    layers: [{ id: 'ly1', name: 'Base' }, { id: 'ly2', name: 'Top' }],
    sketches: [{ id: 's1', name: 'S', entities: [
      { type: 'line', id: 'L1', layerId: 'ly1', p1: pt('a', 0, 0), p2: pt('b', 40, 0) },
      { type: 'line', id: 'L2', layerId: 'ly1', p1: pt('b', 40, 0), p2: pt('c', 40, 20) },
      { type: 'line', id: 'L3', layerId: 'ly2', p1: pt('d', 0, 50), p2: pt('e', 30, 50) }],
    constraints: [
      { id: 'c1', kind: 'fix', pointId: 'a', x: 0, y: 0 },
      { id: 'c2', kind: 'horizontal', lineId: 'L1', p1: 'a', p2: 'b' },
      { id: 'c3', kind: 'vertical', lineId: 'L2', p1: 'b', p2: 'c' },
      { id: 'c4', kind: 'distance', p1: 'a', p2: 'b', value: 40, name: 'D1', expr: 'w', labelOffset: -8 },
      { id: 'c5', kind: 'distance', p1: 'b', p2: 'c', value: 20, name: 'D2' },
      { id: 'c6', kind: 'distance', p1: 'd', p2: 'e', value: 30, name: 'D3', labelOffset: 8 }] }] });
  a._afterStateSwap(); a.view.zoom = 5; a.view.panX = -100; a.view.panY = 120; a.commit({ diagnostics: 'sync' });
});
const dimsFor = () => page.evaluate(async () => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return window._app.renderer.lastDimRects.map(r => r.constraint.name).sort().join(',');
});
const onBase = await dimsFor();
await page.evaluate(() => { const a = window._app; a.project.activeLayerId = 'ly2'; a.project.syncLocks(); a.clearSelection(); a.solveAndRender(); });
const onTop = await dimsFor();
check(onBase === 'D1,D2' && onTop === 'D3', `only the active layer's dimensions can be picked (Base: ${onBase} / Top: ${onTop})`);
await page.evaluate(() => { const a = window._app; a.project.variables[0].expr = '60'; a.commit({ diagnostics: 'sync' }); });
const layerStatus = await page.evaluate(() => {
  const s = window._app.activeSketch(), st = (id) => s.entities.find(e => e.id === id);
  const L1 = st('L1');
  return { L1: L1.status, L2: st('L2').status, L3: st('L3').status, len: +Math.hypot(L1.p2.x - L1.p1.x, L1.p2.y - L1.p1.y).toFixed(6) };
});
check(layerStatus.L1 === 'fully' && layerStatus.L2 === 'fully' && layerStatus.L3 === 'under' && layerStatus.len === 60,
  `variable changed from Top: Base rebuilt and still shown fully defined (${JSON.stringify(layerStatus)})`);
await page.evaluate(() => { const a = window._app; a.project.layer('ly1').visible = false; a.requestRender(); });
const dimLayerStates = await page.evaluate(() => { const a = window._app; return a.activeSketch().constraints.filter(c => c.name).map(c => c.name + ':' + a.constraintLayerState(c)).join(','); });
check(dimLayerStates === 'D1:hidden,D2:hidden,D3:active', `hidden layer hides its dimensions (${dimLayerStates})`);
await page.evaluate(() => { const a = window._app; a.project.layer('ly1').visible = true; a.requestRender(); });

// Fill follows shapes moved by real drags; undo; opened areas.
{
  const loadP = (proj) => page.evaluate((proj) => {
    const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
    a.view.zoom = 4; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' });
    for (const w of ['equations', 'props', 'colors', 'tools', 'layers']) a.windows.toggle(w, false);
    a.setTool('select'); a.requestRender();
  }, proj);
  const colourAtW = (x, y) => page.evaluate(([x, y]) => {
    const d = [...window._app.fillDisplay().values()][0]; if (!d) return null;
    const pip = (poly, p) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const A = poly[i], B = poly[j]; if ((A.y > p.y) !== (B.y > p.y) && p.x < (B.x - A.x) * (p.y - A.y) / (B.y - A.y) + A.x) c = !c; } return c; };
    const f = d.painted.find(f => pip(f.region.outer, { x, y }) && !f.region.holes.some(h => pip(h, { x, y })));
    return f ? f.color : null;
  }, [x, y]);
  const dragW = async (from, to, each) => {
    const A = await W(...from), B = await W(...to);
    await page.mouse.move(box.x + A.x, box.y + A.y); await page.mouse.down();
    const seen = [];
    for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + A.x + (B.x - A.x) * i / 10, box.y + A.y + (B.y - A.y) * i / 10); if (each) seen.push(await each(i)); }
    await page.mouse.up();
    return seen;
  };
  const pt = (id, x, y, fixed = false) => ({ type: 'point', id, x, y, fixed });
  await page.keyboard.press('s');

  await loadP({ version: 3, layers: [{ id: 'L', name: 'L' }], activeLayerId: 'L', sketches: [{ id: 's', name: 'S', entities: [
    { type: 'circle', id: 'c1', layerId: 'L', center: pt('p1', -60, 0), r: 10 }], constraints: [],
    fills: [{ id: 'f1', layerId: 'L', color: '#d63a3a', opacity: 1, seed: { x: -60, y: 0 } }] }] });
  const along = await dragW([-60, 0], [60, 20], async () => {
    const c = await page.evaluate(() => { const e = window._app.activeSketch().entities[0]; return [e.center.x, e.center.y]; });
    return colourAtW(c[0], c[1]);
  });
  check(along.every(c => c === '#d63a3a') && await colourAtW(-60, 0) === null, `dragged filled circle keeps its colour every frame and leaves nothing behind (${[...new Set(along)]})`);
  await page.evaluate(() => window._app.undo());
  check(await colourAtW(-60, 0) === '#d63a3a', 'undo puts the paint back with the circle');

  await loadP({ version: 3, layers: [{ id: 'L', name: 'L' }], activeLayerId: 'L', sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'l1', layerId: 'L', p1: pt('a', -80, -20), p2: pt('b', -40, -20) },
    { type: 'line', id: 'l2', layerId: 'L', p1: pt('b', -40, -20), p2: pt('c', -40, 10) },
    { type: 'line', id: 'l3', layerId: 'L', p1: pt('c', -40, 10), p2: pt('d', -80, 10) },
    { type: 'line', id: 'l4', layerId: 'L', p1: pt('d', -80, 10), p2: pt('a', -80, -20) }], constraints: [],
    fills: [{ id: 'f1', layerId: 'L', color: '#1f7ad6', opacity: 1, seed: { x: -60, y: -5 } }] }] });
  const s1 = await W(-90, 20), s2 = await W(-30, -30);
  await page.mouse.move(box.x + s1.x, box.y + s1.y); await page.mouse.down(); await page.mouse.move(box.x + s2.x, box.y + s2.y, { steps: 5 }); await page.mouse.up();
  const rectFrames = await dragW([-60, -20], [40, 30], (i) => colourAtW(-60 + 100 * i / 10, -5 + 50 * i / 10));
  check(rectFrames.every(c => c === '#1f7ad6') && await colourAtW(40, 45) === '#1f7ad6' && await colourAtW(-60, -5) === null,
    `box-selected filled rectangle moves with its colour (${[...new Set(rectFrames)]})`);

  await loadP({ version: 3, layers: [{ id: 'L', name: 'L' }], activeLayerId: 'L', sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'l1', layerId: 'L', p1: pt('a', -4, 0, true), p2: pt('b', 40, 0, true) },
    { type: 'line', id: 'l2', layerId: 'L', p1: pt('b', 40, 0, true), p2: pt('c', 20, 30, true) },
    { type: 'line', id: 'l3', layerId: 'L', p1: pt('c', 20, 30, true), p2: pt('d', 4, 0) }], constraints: [],
    fills: [{ id: 'f1', layerId: 'L', color: '#14946b', opacity: 1, seed: { x: 20, y: 8 } }] }] });
  // Open and close again within one drag: the paint is still there.
  const A0 = await W(4, 0), A1 = await W(-20, 20), A2 = await W(6, 0);
  await page.mouse.move(box.x + A0.x, box.y + A0.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + A0.x + (A1.x - A0.x) * i / 8, box.y + A0.y + (A1.y - A0.y) * i / 8);
  const openMid = await colourAtW(20, 8);
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + A1.x + (A2.x - A1.x) * i / 8, box.y + A1.y + (A2.y - A1.y) * i / 8);
  await page.mouse.up();
  const sameDrag = await colourAtW(20, 8);
  // Open it and release: removed; undo brings it back.
  await dragW([6, 0], [-20, 20]);
  const removed = await page.evaluate(() => window._app.activeSketch().fills.length);
  await page.evaluate(() => window._app.undo());
  const undone = await colourAtW(20, 8);
  check(openMid === null && sameDrag === '#14946b' && removed === 0 && undone === '#14946b',
    `opening a filled area: gone while open, back if closed in the same drag, removed on release, undo restores (${openMid}/${sameDrag}/${removed}/${undone})`);
}

// Dragging overlapping painted circles around: the circles keep their
// colours and nothing is left behind.
{
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  await page.evaluate((proj) => {
    const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
    a.view.zoom = 4; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' });
    for (const w of ['equations', 'props', 'colors', 'tools', 'layers']) a.windows.toggle(w, false);
    a.setTool('select');
  }, { version: 3, layers: [{ id: 'L', name: 'L' }], activeLayerId: 'L', sketches: [{ id: 's', name: 'S', entities: [
    { type: 'circle', id: 'A', layerId: 'L', center: pt('ca', -10, 0), r: 20 },
    { type: 'circle', id: 'B', layerId: 'L', center: pt('cb', 15, 0), r: 20 }], constraints: [],
    fills: [{ id: 'f1', layerId: 'L', color: '#5b5fd6', opacity: 1, seed: { x: -20, y: 0 } },
            { id: 'f2', layerId: 'L', color: '#5b5fd6', opacity: 1, seed: { x: 25, y: 0 } },
            { id: 'f3', layerId: 'L', color: '#c9a400', opacity: 1, seed: { x: 2.5, y: 0 } }] }] });
  // Pull A far left, B far right, then wander with B: the painted pieces'
  // old places end up empty, as in the reported sketch.
  const moves = [[[-10, 0], [-70, 0]], [[15, 0], [80, 0]], [[80, 0], [60, 45]], [[60, 45], [90, -40]]];
  for (const [from, to] of moves) {
    const A = await W(...from), B = await W(...to);
    await page.mouse.move(box.x + A.x, box.y + A.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + A.x + (B.x - A.x) * i / 8, box.y + A.y + (B.y - A.y) * i / 8);
    }
    await page.mouse.up();
  }
  const after = await page.evaluate(() => window._app.activeSketch().fills.map(f => f.color));
  check(after.length === 2 && after.every(c => c === '#5b5fd6'),
    `overlapping painted circles pulled apart: each keeps its colour, the lens paint is gone (${after})`);
}

// Layers never share a point; relations are shown as badges.
{
  const click = async (x, y) => { const s = await W(x, y); await page.mouse.click(box.x + s.x, box.y + s.y); };
  const pt = (id, x, y, fixed = false) => ({ type: 'point', id, x, y, fixed });
  const load = (proj) => page.evaluate((proj) => {
    const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
    a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' });
    for (const w of ['equations', 'props', 'colors', 'tools', 'layers']) a.windows.toggle(w, false);
    a.setTool('select');
  }, proj);
  const rectProj = { version: 3, activeLayerId: 'ly1', layers: [{ id: 'ly1', name: 'Base' }, { id: 'ly2', name: 'Top' }], sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'r1', layerId: 'ly1', p1: pt('a', -40, -20), p2: pt('b', 0, -20) },
    { type: 'line', id: 'r2', layerId: 'ly1', p1: pt('b', 0, -20), p2: pt('c', 0, 10) },
    { type: 'line', id: 'r3', layerId: 'ly1', p1: pt('c', 0, 10), p2: pt('d', -40, 10) },
    { type: 'line', id: 'r4', layerId: 'ly1', p1: pt('d', -40, 10), p2: pt('a', -40, -20) }], constraints: [
    { id: 'k1', kind: 'horizontal', lineId: 'r1', p1: 'a', p2: 'b' }, { id: 'k2', kind: 'vertical', lineId: 'r2', p1: 'b', p2: 'c' }] }] };

  // 1. Draw on Top from Base's corner (0,10).
  await load(rectProj);
  await page.evaluate(() => { const a = window._app; a.project.activeLayerId = 'ly2'; a.project.syncLocks(); a.clearSelection(); a.solveAndRender(); });
  await page.keyboard.press('l'); await click(0, 10); await click(30, 30); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('s');
  const drawn = await page.evaluate(() => {
    const a = window._app, s = a.activeSketch();
    const top = s.entities.find(e => e.layerId === 'ly2'); const base = s.entities.find(e => e.id === 'r2');
    const link = s.constraints.find(c => c.kind === 'coincident' && [c.p1, c.p2].includes(top.p1.id));
    return { shared: top.p1 === base.p2, sameId: top.p1.id === base.p2.id, link: link && { other: link.p1 === top.p1.id ? link.p2 : link.p1, layer: link.layerId }, cId: 'c' };
  });
  check(!drawn.shared && drawn.link && drawn.link.other === 'c' && drawn.link.layer === 'ly2',
    `line drawn on Top from Base's corner gets its own point + coincident on Top (${JSON.stringify(drawn)})`);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const badges = await page.evaluate(() => window._app.renderer.lastRelRects.map(r => r.constraint.kind).sort().join(','));
  check(/coincident/.test(badges), `the coincident is shown as a badge (${badges})`);

  // 2. Delete Base's vertical line (switch to Base): Top line stays.
  const topBefore = await page.evaluate(() => { const l = window._app.activeSketch().entities.find(e => e.layerId === 'ly2'); return [l.p1.x, l.p1.y, l.p2.x, l.p2.y]; });
  await page.evaluate(() => { const a = window._app; a.project.activeLayerId = 'ly1'; a.project.syncLocks(); a.clearSelection(); a.solveAndRender(); });
  await click(0, -5); await page.keyboard.press('Delete');
  const afterDelBase = await page.evaluate(() => { const s = window._app.activeSketch(); const l = s.entities.find(e => e.layerId === 'ly2'); return { r2: !!s.entities.find(e => e.id === 'r2'), top: l && [l.p1.x, l.p1.y, l.p2.x, l.p2.y], link: s.constraints.some(c => c.kind === 'coincident') }; });
  check(!afterDelBase.r2 && JSON.stringify(afterDelBase.top) === JSON.stringify(topBefore),
    `deleting Base's line leaves Top's line where it was (${JSON.stringify(afterDelBase)})`);
  // 3. Undo, delete the Top line instead: Base untouched.
  await page.evaluate(() => window._app.undo());
  const baseBefore = await page.evaluate(() => window._app.activeSketch().entities.filter(e => e.layerId === 'ly1').map(e => [e.id, e.p1.x, e.p1.y, e.p2.x, e.p2.y].join(':')).join('|'));
  await page.evaluate(() => { const a = window._app; a.project.activeLayerId = 'ly2'; a.project.syncLocks(); a.clearSelection(); a.solveAndRender(); });
  await click(15, 20); await page.keyboard.press('Delete');
  const afterDelTop = await page.evaluate(() => ({ top: window._app.activeSketch().entities.filter(e => e.layerId === 'ly2').length,
    base: window._app.activeSketch().entities.filter(e => e.layerId === 'ly1').map(e => [e.id, e.p1.x, e.p1.y, e.p2.x, e.p2.y].join(':')).join('|') }));
  check(afterDelTop.top === 0 && afterDelTop.base === baseBefore, 'deleting Top\'s line leaves Base untouched');

  // 4. Move a Base line (sharing corners) to Top via the selection layer menu.
  await load(rectProj);
  await page.evaluate(() => window._app.windows.toggle('props', true));
  await click(-20, -20);           // r1
  await page.selectOption('#sel-body select[data-move-layer]', 'ly2');
  const moved = await page.evaluate(() => {
    const s = window._app.activeSketch(); const r1 = s.entities.find(e => e.id === 'r1'), r2 = s.entities.find(e => e.id === 'r2'), r4 = s.entities.find(e => e.id === 'r4');
    const links = s.constraints.filter(c => c.kind === 'coincident' && c.layerId === 'ly2').length;
    const h = s.constraints.find(c => c.id === 'k1');
    return { sharedB: r1.p2 === r2.p1, sharedA: r1.p1 === r4.p2, links, hOnCopy: h.p1 === r1.p1.id && h.p2 === r1.p2.id };
  });
  check(!moved.sharedA && !moved.sharedB && moved.links === 2 && moved.hOnCopy, `moving a shape to another layer splits its shared corners (${JSON.stringify(moved)})`);

  // 5. Older file with a point shared across layers is split on load.
  await load({ version: 3, activeLayerId: 'ly1', layers: [{ id: 'ly1', name: 'A' }, { id: 'ly2', name: 'B' }], sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'x1', layerId: 'ly1', p1: pt('m', 0, 0), p2: pt('n', 20, 0) },
    { type: 'line', id: 'x2', layerId: 'ly2', p1: pt('n', 20, 0), p2: pt('o', 20, 20) }], constraints: [] }] });
  const legacy = await page.evaluate(() => { const s = window._app.activeSketch(); const [x1, x2] = s.entities; return { shared: x1.p2 === x2.p1, links: s.constraints.filter(c => c.kind === 'coincident').length }; });
  check(!legacy.shared && legacy.links === 1, `older shared point split on load (${JSON.stringify(legacy)})`);

  // 6. Select a relation badge and delete it.
  await load(rectProj);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const rect = await page.evaluate(() => { const r = window._app.renderer.lastRelRects.find(r => r.constraint.kind === 'horizontal'); return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 }; });
  await page.mouse.click(box.x + rect.x, box.y + rect.y);
  const sel = await page.evaluate(() => window._app.activeSketch().constraints.filter(c => c.selected).map(c => c.kind).join(','));
  await page.keyboard.press('Delete');
  const left = await page.evaluate(() => window._app.activeSketch().constraints.map(c => c.kind).join(','));
  check(sel === 'horizontal' && left === 'vertical', `click a relation badge, Delete removes it (selected ${sel}; left ${left})`);

}

// Sketch window: pen and marker draw strokes on the active layer, the
// eraser removes them (active layer only), each is one undo step.
{
  const strokes = () => page.evaluate(() => window._app.activeSketch().strokes.map(s => s.kind + ':' + s.points.length).join(','));
  const drag = async (x0, y0, x1, y1) => {
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12 + Math.sin(i) * 6);
    await page.mouse.up();
  };
  check(await page.isVisible('.fwin[data-win="sketch"]'), 'Sketch window is open');
  check(await page.isVisible('#sketch-body [data-tool="fill"]') && !(await page.isVisible('#tools-body [data-tool="fill"]')), 'Fill is in the Sketch window, not in Tools');
  await page.evaluate(() => window._app.windows.toggle('colors', true));
  // One colour for Fill, Pen and Marker; the opacity slider follows the tool.
  const opLabel = () => page.evaluate(() => document.querySelector('#colors-body .prop-row label').textContent);
  await page.keyboard.press('b');
  check(await opLabel() === 'Fill opacity' && await page.evaluate(() => document.querySelectorAll('#colors-body .pc-sw').length) === 1, 'Colors window: one colour; Fill shows the fill opacity');
  await page.keyboard.press('n');
  check(await opLabel() === 'Pen opacity', 'Pen shows the pen opacity');
  await page.click('#colors-body .palette .sw[data-c="#14946b"]');
  const one = await page.evaluate(() => ({ colour: window._app.pen.fillColor, ink: window._app.pen.inkColor }));
  check(one.colour === '#14946b' && one.ink === undefined, `a swatch sets the one colour (${JSON.stringify(one)})`);
  await page.click('#colors-body .palette .sw[data-c="#111418"]');
  await page.click('.fwin[data-win="sketch"] [data-tool="pen"]');
  await drag(cx - 250, cy + 150, cx + 250, cy + 150);
  await page.keyboard.press('g');
  await drag(cx - 250, cy + 190, cx + 250, cy + 190);
  const drawn = await strokes();
  check(/^pen:\d+,marker:\d+$/.test(drawn), `pen and marker draw strokes (${drawn})`);
  check(await page.evaluate(() => window._app.activeSketch().strokes.every(k => k.color === window._app.pen.fillColor)), 'strokes use the one colour');
  await page.keyboard.press('Control+z');
  check(/^pen:\d+$/.test(await strokes()), 'undo removes the last stroke');
  // A stroke on another layer survives the eraser.
  await page.evaluate(() => { const a = window._app; a.project.addLayer('Ink 2'); a.refreshUI(); });
  await page.keyboard.press('n');
  await drag(cx - 250, cy + 230, cx + 250, cy + 230);
  await page.evaluate(() => { const a = window._app; a.project.activeLayerId = a.project.layers[0].id; a.refreshUI(); });
  await page.keyboard.press('e');
  await drag(cx, cy + 120, cx, cy + 260);
  const left = await page.evaluate(() => { const a = window._app; return a.activeSketch().strokes.map(s => a.project.layer(s.layerId).name); });
  check(left.length === 1 && left[0] === 'Ink 2', `eraser removes strokes on the active layer only (left: ${left.join(',')})`);
  await page.keyboard.press('Control+z');
  check(/^pen:\d+,pen:\d+$/.test(await strokes()), 'undo brings erased strokes back');
  await page.keyboard.press('s');
}

// Report a problem: subtle link, form posts to Formspree (intercepted here).
{
  let posted = null;
  await page.route('https://formspree.io/**', async (route) => { posted = route.request().postData() || ''; await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  check(await page.isVisible('#report-open'), 'report link in the status bar');
  await page.click('#report-open');
  await page.click('#report-send');                              // empty: not sent
  check(posted === null && await page.isVisible('#report-modal'), 'empty report is not sent');
  await page.fill('#report-message', 'Test report from the smoke test');
  await page.check('#report-form input[name=attach]');
  await page.click('#report-send');
  await page.waitForFunction(() => document.getElementById('report-status').textContent.startsWith('Sent'));
  check(/Test report/.test(posted) && /name="context"/.test(posted) && /name="project"/.test(posted), 'report posts message, context and the attached drawing');
  await page.waitForFunction(() => !document.getElementById('report-modal').classList.contains('show'));
  await page.unroute('https://formspree.io/**');
}

// The project survives a reload (autosaved to the browser, restored on open).
{
  const sig = () => page.evaluate(() => { const s = window._app.activeSketch(); return JSON.stringify({ e: s.entities.length, c: s.constraints.length, l: window._app.project.layers.length }); });
  const before = await sig();
  await page.reload();
  await page.waitForFunction(() => window._app);
  const after = await sig();
  check(before === after && JSON.parse(after).e > 0, `project restored after reload (${before} → ${after})`);
}

// Ink with the Select tool: click, Ctrl-click, box, drag, delete, mixed drags.
{
  const P = (id, x, y) => ({ type: 'point', id, x, y });
  const proj = { version: 3, activeLayerId: 'la', layers: [{ id: 'la', name: 'A' }, { id: 'lb', name: 'B' }], sketches: [{ id: 's', name: 'S',
    entities: [{ type: 'line', id: 'g1', layerId: 'la', p1: P('ga', -30, 10), p2: P('gb', 30, 10) }],
    constraints: [],
    strokes: [
      { id: 'k1', layerId: 'la', kind: 'pen', color: '#d63a3a', opacity: 1, width: 0.6, pts: [-20, -10, 0, -14, 20, -10] },
      { id: 'k2', layerId: 'la', kind: 'pen', color: '#1f7ad6', opacity: 1, width: 0.6, pts: [-20, -25, 20, -25] },
      { id: 'k3', layerId: 'lb', kind: 'pen', color: '#14946b', opacity: 1, width: 0.6, pts: [-20, -35, 20, -35] },
      { id: 'k4', layerId: 'la', kind: 'marker', color: '#c9a400', opacity: 0.4, width: 4, pts: [-25, 10, 25, 10] },
    ] }] };
  await page.evaluate((proj) => {
    const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
    a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.setTool('select');
    for (const w of ['colors', 'tools', 'layers', 'sketch', 'equations']) a.windows.toggle(w, false);
    a.windows.toggle('props', true);
  }, proj);
  const scr = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
  const sel = () => page.evaluate(() => window._app.activeSketch().strokes.filter(s => s.selected).map(s => s.id).join(','));
  const pts = (id) => page.evaluate((id) => window._app.activeSketch().strokes.find(s => s.id === id)?.points.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]), id);

  let at = await scr(0, -14);
  await page.mouse.click(at.x, at.y);
  check(await sel() === 'k1' && /Ink \(1 stroke\)/.test(await page.textContent('#sel-body')), 'click selects a stroke; Properties shows Ink');
  const to = await scr(10, -4);
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
  const moved = await pts('k1');
  check(JSON.stringify(moved) === JSON.stringify([[-10, 0], [10, -4], [30, 0]]), `dragging moves the stroke (${JSON.stringify(moved)})`);
  await page.keyboard.press('Control+z');
  check(JSON.stringify(await pts('k1')) === JSON.stringify([[-20, -10], [0, -14], [20, -10]]), 'undo puts it back');

  at = await scr(0, -14); await page.mouse.click(at.x, at.y);
  const at2 = await scr(0, -25); await page.keyboard.down('Control'); await page.mouse.click(at2.x, at2.y); await page.keyboard.up('Control');
  check(await sel() === 'k1,k2', `Ctrl-click adds a stroke (${await sel()})`);
  await page.keyboard.press('Delete');
  check(await page.evaluate(() => window._app.activeSketch().strokes.map(s => s.id).join(',')) === 'k3,k4', 'Delete removes the selected strokes');
  await page.keyboard.press('Control+z');

  const b0 = await scr(-40, -30), b1 = await scr(40, -5);
  await page.mouse.move(b0.x, b0.y); await page.mouse.down(); await page.mouse.move(b1.x, b1.y, { steps: 5 }); await page.mouse.up();
  check(await sel() === 'k1,k2', `box selects strokes inside it, not other layers (${await sel()})`);
  await page.keyboard.press('Escape');

  at = await scr(0, -35); await page.mouse.click(at.x, at.y);
  check(await sel() === '', 'strokes on another layer are not picked');

  at = await scr(10, 10); await page.mouse.click(at.x, at.y);
  const lineSel = await page.evaluate(() => window._app.activeSketch().entities.find(e => e.id === 'g1').selected);
  check(lineSel && await sel() === '', 'a shape under the cursor wins over ink');
  const atInk = await scr(0, -14);
  await page.keyboard.down('Shift'); await page.mouse.click(atInk.x, atInk.y); await page.keyboard.up('Shift');
  const g0 = await scr(-10, 10), g1 = await scr(-10, 20);
  await page.mouse.move(g0.x, g0.y); await page.mouse.down(); await page.mouse.move(g1.x, g1.y, { steps: 6 }); await page.mouse.up();
  const both = await page.evaluate(() => { const s = window._app.activeSketch(); const l = s.entities.find(e => e.id === 'g1'); const k = s.strokes.find(x => x.id === 'k1');
    return [Math.round(l.p1.y), Math.round(k.points[0].y)]; });
  check(both[0] === 20 && both[1] === 0, `selected ink moves with a dragged shape (${both})`);

  await page.evaluate(() => { window._app.clearSelection(); });
  at = await scr(0, -25); await page.mouse.click(at.x, at.y);
  await page.fill('#sel-body input[data-ink-k="width"]', '1.5'); await page.press('#sel-body input[data-ink-k="width"]', 'Enter');
  await page.$eval('#sel-body input[data-ink-k="color"]', (el) => { el.value = '#8a4fd1'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  const k2 = await page.evaluate(() => { const k = window._app.activeSketch().strokes.find(x => x.id === 'k2'); return [k.width, k.color]; });
  check(k2[0] === 1.5 && k2[1] === '#8a4fd1', `Properties changes ink width and colour (${k2})`);
  await page.keyboard.press('Escape');
}

// Right-click actions, Blender-style scrubbing, click-to-link dimensions.
{
  const P = (id, x, y) => ({ type: 'point', id, x, y });
  const proj = { version: 3, activeLayerId: 'ly1', layers: [{ id: 'ly1', name: 'L' }], sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'q1', p1: P('qa', -40, 0), p2: P('qb', 0, 0) },
    { type: 'line', id: 'q2', p1: P('qb', 0, 0), p2: P('qc', 0, 20) },
    { type: 'line', id: 'q3', p1: P('qc', 0, 20), p2: P('qd', -40, 20) },
    { type: 'line', id: 'q4', p1: P('qd', -40, 20), p2: P('qa', -40, 0) },
    { type: 'line', id: 'f1', p1: P('fa', 20, -20), p2: P('fb', 50, -20) },
  ], constraints: [
    { id: 'h1', kind: 'horizontal', lineId: 'q1', p1: 'qa', p2: 'qb' }, { id: 'h2', kind: 'horizontal', lineId: 'q3', p1: 'qc', p2: 'qd' },
    { id: 'v1', kind: 'vertical', lineId: 'q2', p1: 'qb', p2: 'qc' }, { id: 'v2', kind: 'vertical', lineId: 'q4', p1: 'qd', p2: 'qa' },
    { id: 'fx', kind: 'fix', pointId: 'qa', x: -40, y: 0 }, { id: 'hf', kind: 'horizontal', lineId: 'f1', p1: 'fa', p2: 'fb' },
    { id: 'fx2', kind: 'fix', pointId: 'fa', x: 20, y: -20 },
    { id: 'dw', kind: 'distance', p1: 'qa', p2: 'qb', value: 40, name: 'D1', labelOffset: -8 },
    { id: 'dh', kind: 'distance', p1: 'qb', p2: 'qc', value: 20 },
  ] }] };
  const loadQ = () => page.evaluate((proj) => {
    const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
    a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.setTool('select');
    for (const w of ['props', 'colors', 'tools', 'layers', 'sketch']) a.windows.toggle(w, false);
  }, proj);
  const scr = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
  await loadQ();

  // 1. Right-click a line: construction, then create midpoint.
  let at = await scr(35, -20);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const labels = await page.$$eval('#context-menu .action span:last-child', els => els.map(e => e.textContent.trim()));
  check(labels.includes('Set as construction') && labels.includes('Create midpoint'), `right-click offers construction and midpoint (${labels.join(' | ')})`);
  await page.click('#context-menu [data-action="construction"]');
  check(await page.evaluate(() => window._app.activeSketch().entities.find(e => e.id === 'f1').construction), 'Set as construction');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  check(await page.textContent('#context-menu [data-action="construction"]').then(t => /normal geometry/.test(t)), 'menu then offers Set as normal geometry');
  await page.click('#context-menu [data-action="midpoint"]');
  const mid = await page.evaluate(() => { const s = window._app.activeSketch(); const c = s.constraints.find(c => c.kind === 'midpoint');
    const p = s.entities.find(e => e.id === c?.pointId); return p && [p.x, p.y]; });
  check(mid && Math.abs(mid[0] - 35) < 1e-6 && Math.abs(mid[1] + 20) < 1e-6, `Create midpoint puts a point held at the middle (${mid})`);
  await page.evaluate(() => { const a = window._app; const f = a.activeSketch().entities.find(e => e.id === 'f1'); f.construction = false; a.commit(); });

  // 2. Scrub a variable and a dimension in the Equations window.
  await page.evaluate(() => { const a = window._app; a.project.variables.push({ name: 'k', expr: '10' }); a.commit(); a.windows.toggle('equations', true); a._refreshEquationsPanel(); });
  let vb = await page.locator('[data-scrub="var:0"]').boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2); await page.mouse.down();
  await page.mouse.move(vb.x + vb.width / 2 + 25, vb.y + 5, { steps: 5 }); await page.mouse.move(vb.x + vb.width / 2 + 50, vb.y + 5, { steps: 5 }); await page.mouse.up();
  check(await page.evaluate(() => window._app.project.variables[0].expr) === '15', 'dragging a variable value by 50 px adds 50 × 0.1');
  const dimIdx = await page.evaluate(() => [...document.querySelectorAll('#equations-body [data-k="dim-name"]')].findIndex(i => i.value === 'D1'));
  vb = await page.locator(`[data-scrub="dim:${dimIdx}"]`).boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2); await page.mouse.down();
  await page.mouse.move(vb.x + vb.width / 2 + 30, vb.y + 5, { steps: 6 });
  const live = await page.evaluate(() => { const s = window._app.activeSketch(); const b = s.entities.find(e => e.id === 'q1'); return Math.round(Math.hypot(b.p2.x - b.p1.x, b.p2.y - b.p1.y) * 10) / 10; });
  await page.mouse.up();
  check(live === 43, `dragging D1's value resizes the rectangle live (40 → ${live})`);
  vb = await page.locator(`[data-scrub="dim:${dimIdx}"]`).boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2); await page.mouse.down();
  await page.mouse.move(vb.x + vb.width / 2 + 40, vb.y + 5, { steps: 4 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  check(await page.evaluate(() => window._app.activeSketch().constraints.find(c => c.name === 'D1').value) === 43, 'Esc during a scrub restores the value');
  await page.evaluate(() => window._app.windows.toggle('equations', false));

  // 3. Edit D1, click the free line: =D2 with a new floating dimension, then drag that line.
  await page.evaluate(() => { const a = window._app; a.requestRender(); });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => { const a = window._app; a.editDimValue(a.activeSketch().constraints.find(c => c.name === 'D1')); });
  await page.waitForSelector('.dim-input');
  at = await scr(35, -20);
  await page.mouse.click(at.x, at.y);
  const typed = await page.inputValue('.dim-input');
  const floating = await page.evaluate(() => window._app.activeSketch().constraints.filter(c => c.driven).map(c => c.name + '=' + Math.round(c.value)));
  check(/^=D\d+$/.test(typed) && floating.length === 1 && floating[0] === typed.slice(1) + '=30', `click a line while editing: ${typed}, floating ${floating}`);
  await page.keyboard.press('Enter');
  const w1 = await page.evaluate(() => { const s = window._app.activeSketch(); const b = s.entities.find(e => e.id === 'q1'); return Math.round(Math.hypot(b.p2.x - b.p1.x, b.p2.y - b.p1.y)); });
  check(w1 === 30, `D1 follows the clicked line (width ${w1})`);
  const end = await scr(50, -20), to = await scr(70, -20);
  await page.mouse.move(end.x, end.y); await page.mouse.down();
  await page.mouse.move((end.x + to.x) / 2, end.y, { steps: 4 }); await page.mouse.move(to.x, to.y, { steps: 4 });
  const during = await page.evaluate(() => { const s = window._app.activeSketch(); const b = s.entities.find(e => e.id === 'q1'); return Math.round(Math.hypot(b.p2.x - b.p1.x, b.p2.y - b.p1.y)); });
  await page.mouse.up();
  const after = await page.evaluate(() => { const s = window._app.activeSketch(); const b = s.entities.find(e => e.id === 'q1'); const f = s.entities.find(e => e.id === 'f1');
    return [Math.round(Math.hypot(b.p2.x - b.p1.x, b.p2.y - b.p1.y)), Math.round(f.p2.x - f.p1.x), document.getElementById('status-solve').textContent]; });
  check(during === 50 && after[0] === 50 && after[1] === 50, `dragging the linked line resizes the rectangle live (during ${during}, after ${after.slice(0, 2)})`);
}

// Smart Dimension on a slanted line: the cursor picks X, Y or the length.
{
  const P = (id, x, y) => ({ type: 'point', id, x, y });
  await page.evaluate((proj) => {
    const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
    a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.setTool('smartdim');
    for (const w of ['props', 'colors', 'tools', 'layers', 'sketch', 'equations']) a.windows.toggle(w, false);
  }, { version: 3, activeLayerId: 'la', layers: [{ id: 'la', name: 'A' }], sketches: [{ id: 's', name: 'S',
    entities: [{ type: 'line', id: 'sl', p1: P('sa', -20, -10), p2: P('sb', 20, 10) }],
    constraints: [{ id: 'fx', kind: 'fix', pointId: 'sa', x: -20, y: -10 }] }] });
  const scr = (x, y) => page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]).then(p => ({ x: box.x + p.x, y: box.y + p.y }));
  const axisAt = async (x, y) => { const q = await scr(x, y); await page.mouse.move(q.x, q.y, { steps: 2 });
    return page.evaluate(() => { const p = window._app.tool.preview; return p ? (p.axis || 'length') + ':' + p.value.toFixed(2) : 'none'; }); };
  let at = await scr(0, 0); await page.mouse.click(at.x, at.y);           // pick the line
  const above = await axisAt(0, 20), right = await axisAt(30, 0), beside = await axisAt(-4, 6), corner = await axisAt(30, 20);
  check(above === 'x:40.00' && right === 'y:20.00' && beside === 'length:44.72' && corner === 'length:44.72',
    `cursor picks the type: above ${above}, right ${right}, beside ${beside}, off a corner ${corner}`);
  at = await scr(0, 20); await page.mouse.move(at.x, at.y, { steps: 2 }); await page.mouse.click(at.x, at.y);
  await page.waitForSelector('.dim-input'); await page.fill('.dim-input', '50'); await page.keyboard.press('Enter');
  const xr = await page.evaluate(() => { const s = window._app.activeSketch(); const c = s.constraints.find(c => c.kind === 'distance');
    const l = s.entities[0]; return { axis: c.axis, dx: +(l.p2.x - l.p1.x).toFixed(4), dy: +(l.p2.y - l.p1.y).toFixed(4) }; });
  check(xr.axis === 'x' && xr.dx === 50 && xr.dy !== 0, `X dimension placed above sets the horizontal distance (${JSON.stringify(xr)})`);
  at = await scr(10, 3); await page.mouse.click(at.x, at.y);             // pick the line again
  at = await scr(45, 0); await page.mouse.move(at.x, at.y, { steps: 2 }); await page.mouse.click(at.x, at.y);
  await page.waitForSelector('.dim-input'); await page.fill('.dim-input', '12'); await page.keyboard.press('Enter');
  const yr = await page.evaluate(() => { const s = window._app.activeSketch(); const l = s.entities[0];
    return { axes: s.constraints.filter(c => c.kind === 'distance').map(c => c.axis).join(','), dx: +(l.p2.x - l.p1.x).toFixed(4), dy: +(l.p2.y - l.p1.y).toFixed(4),
      state: document.getElementById('status-state').textContent, label: document.querySelector('#equations-body') && window._app.constructor.name }; });
  check(yr.axes === 'x,y' && yr.dx === 50 && yr.dy === 12, `then a Y dimension to the right sets the vertical distance (${JSON.stringify(yr)})`);
  await page.evaluate(() => { const a = window._app; a.setTool('select'); a.windows.toggle('equations', true); a._refreshEquationsPanel(); });
  const titles = await page.$$eval('#equations-body [data-k="dim-name"]', els => els.map(e => e.title).join(','));
  check(titles === 'Horizontal distance,Vertical distance', `Equations window names them (${titles})`);
  await page.evaluate(() => window._app.windows.toggle('equations', false));
}

// Equations window: a fixed error clears its red box and shows the value.
{
  await page.evaluate(() => { const a = window._app; a.project.variables.push({ name: 'qq', expr: '1' }); a.commit(); a.windows.toggle('equations', true); a._refreshEquationsPanel(); });
  const i = await page.evaluate(() => window._app.project.variables.length - 1);
  const sel = `[data-k="var-expr"][data-i="${i}"]`;
  await page.fill(sel, '2+*'); await page.press(sel, 'Enter');
  const bad = await page.evaluate((sel) => [document.querySelector(sel).classList.contains('bad'), document.querySelector('[data-val="var:' + sel.match(/\d+/)[0] + '"]').textContent], sel);
  await page.fill(sel, '2+3*4'); await page.press(sel, 'Enter');
  const good = await page.evaluate(([sel, i]) => [document.querySelector(sel).classList.contains('bad'), document.querySelector(`[data-val="var:${i}"]`).textContent, document.activeElement === document.querySelector(sel)], [sel, i]);
  check(bad[0] === true && bad[1] === '!' && good[0] === false && good[1] === '14' && good[2], `fixing an equation clears the red box and shows 2+3*4 = 14, focus kept (${JSON.stringify({ bad, good })})`);
  await page.evaluate(() => { const a = window._app; a.project.variables.pop(); a.commit(); a.windows.toggle('equations', false); });
}

// /app/?example=desk opens the landing page's desk, fully defined, and
// stays fully defined when the width changes (metre-scale dimensions).
{
  await page.goto(`http://localhost:${port}/app/?example=desk`);
  await page.waitForFunction(() => window._app && window._app.project.name === 'Desk concept');
  await page.waitForTimeout(400);
  const st = () => page.evaluate(() => ({ state: document.getElementById('status-state').textContent, url: location.search,
    fills: window._app.activeSketch().fills.length, strokes: window._app.activeSketch().strokes.length }));
  const a = await st();
  check(a.state === 'Fully defined' && a.url === '' && a.fills === 2 && a.strokes === 4, `example opens fully defined (${JSON.stringify(a)})`);
  const d = await page.evaluate(() => { const app = window._app, s = app.activeSketch(); const c = s.constraints.find(c => c.name === 'D1');
    app.setDimensionFromText(c, '1.8m'); return s.constraints.filter(c => c.name).map(c => c.name + '=' + Math.round(c.isDiameter ? c.value * 2 : c.value)).join(' '); });
  await page.waitForTimeout(400);
  const b = await st();
  check(b.state === 'Fully defined' && /D2=900/.test(d) && /D6=900/.test(d), `example follows a new width (${d}; ${b.state})`);
}

await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
if (shot) await page.screenshot({ path: shot });
// App dialogs and notices instead of browser pop-ups.
await page.evaluate(() => { const a = window._app; a.clearSelection?.(); a.selectionOrder = []; a.mirrorSelection(); });
await page.waitForFunction(() => document.getElementById('app-notice')?.classList.contains('show'));
check(/mirror/i.test(await page.textContent('#app-notice')), 'Mirror with nothing selected: a notice, not a pop-up');
await page.evaluate(() => { const w = window._app.windows; if (!w.isOpen('layers')) w.toggle('layers'); });
const dlgLayers = await page.evaluate(() => {
  const p = window._app.project;
  const full = p.layers.find(l => p.entitiesOnLayer(l.id).length);
  if (full) { p.activeLayerId = full.id; window._app.refreshUI(); }
  return { n: p.layers.length, full: !!full };
});
if (dlgLayers.n < 2) await page.click('#layer-add');
if (dlgLayers.n < 2) await page.evaluate(() => { const p = window._app.project; p.activeLayerId = p.layers.find(l => p.entitiesOnLayer(l.id).length).id; window._app.refreshUI(); });
const dlgLayersBefore = await page.evaluate(() => window._app.project.layers.length);
await page.click('#layer-delete');
await page.waitForSelector('.app-dialog .btn.danger');
check(dlgLayers.full && /Delete layer/.test(await page.textContent('#app-dialog-title')), 'deleting a layer with content asks in an app dialog');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.app-dialog'));
check(await page.evaluate((n) => window._app.project.layers.length === n, dlgLayersBefore), 'Escape keeps the layer');
await page.evaluate(() => { const a = window._app; const P = a.project.constructor; const p = new P(); p.addSketch('Sketch 1'); a.project = p; a.refreshUI(); });
await page.click('#layer-delete');
await page.waitForFunction(() => /at least one layer/.test(document.getElementById('app-notice')?.textContent || ''));
check(true, 'deleting the last layer: a notice explains why not');
// Center arc across the ±180° direction: dragging an endpoint a few pixels
// must keep the short arc, not flip it to its complement.
await page.keyboard.press('Escape');
await page.keyboard.press('a');
await page.mouse.click(cx + 300, cy + 150);
await page.mouse.click(cx + 150, cy + 120);
await page.mouse.move(cx + 150, cy + 150, { steps: 5 });
await page.mouse.move(cx + 150, cy + 180, { steps: 5 });
await page.mouse.click(cx + 150, cy + 180);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
const arcSpan = () => page.evaluate(() => {
  const a = window._app.activeSketch().entities.filter(e => e.constructor.kind === 'arc').pop();
  const n = v => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return a ? (a.clockwise ? -n(a.a0 - a.a1) : n(a.a1 - a.a0)) * 180 / Math.PI : null;
});
const arcBefore = await arcSpan();
const arcEnd = await page.evaluate(() => {
  const a = window._app.activeSketch().entities.filter(e => e.constructor.kind === 'arc').pop();
  a.syncEnds(); return window._app.view.worldToScreen(a.end);
});
const cbox = await page.locator('#canvas').boundingBox();
await page.mouse.move(cbox.x + arcEnd.x, cbox.y + arcEnd.y);
await page.mouse.down();
await page.mouse.move(cbox.x + arcEnd.x - 3, cbox.y + arcEnd.y + 6, { steps: 4 });
await page.mouse.up();
const arcAfter = await arcSpan();
check(arcBefore != null && Math.abs(arcBefore) < 60 && Math.abs(arcAfter) < 60 && Math.sign(arcBefore) === Math.sign(arcAfter),
  `center arc keeps its side when an endpoint is dragged (${arcBefore?.toFixed(1)}° → ${arcAfter?.toFixed(1)}°)`);
check(nativeDialogs.length === 0, 'no browser pop-ups' + (nativeDialogs.length ? ': ' + nativeDialogs.join(' | ') : ''));
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);

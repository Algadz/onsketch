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

await page.addInitScript(() => { try { localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light', colorMode: 'style' })); } catch {} });
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

// Drawing style: pick a stroke colour and turn on shape fill, then draw.
await page.evaluate(() => window._app.clearSelection());
// Paint.NET style: left-click a swatch = stroke, right-click = fill.
await page.click('.palette .sw[data-c="#14946b"]');
await page.click('.palette .sw[data-c="#e07b00"]', { button: 'right' });
await page.keyboard.press('r');
await page.selectOption('#optbar select[data-pen="fillShapes"]', '1');
await page.mouse.click(cx + 60, cy + 60);
await page.mouse.click(cx + 200, cy + 160);
await page.keyboard.press('Escape');
await page.keyboard.press('s');
const onLayer2 = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  const ents = a.project.entitiesOnLayer(ly.id);
  return { count: ents.length, style: ents[0]?.style };
});
check(onLayer2.count === 4 && onLayer2.style?.color === '#14946b' && onLayer2.style?.fill === '#e07b00',
  `new shapes use the drawing style (${JSON.stringify(onLayer2)})`);
await page.evaluate(() => window._app._setPen('fillShapes', false, true));

const pixel = (x, y) => page.evaluate(async ([x, y]) => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.getElementById('canvas'), r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  return Array.from(c.getContext('2d').getImageData((x - r.left) * d, (y - r.top) * d, 1, 1).data);
}, [x, y]);
// Fill pixels actually painted inside the rectangle.
const filled = await pixel(cx + 130, cy + 110);
check(filled[3] > 0 && filled[0] > filled[2], `shape fill painted (rgba ${filled.join(',')})`);

// Fill shows while drawing, and overlapping filled shapes keep their colour.
await page.evaluate(() => window._app._setPen('fillShapes', true, true));
await page.keyboard.press('r');
await page.mouse.click(cx + 150, cy + 100);
await page.mouse.move(cx + 270, cy + 210, { steps: 4 });
const previewPx = await pixel(cx + 245, cy + 195);
check(previewPx[3] > 0 && previewPx[0] > previewPx[2], `fill shows while drawing (rgba ${previewPx.join(',')})`);
await page.mouse.click(cx + 270, cy + 210);
await page.keyboard.press('Escape');
await page.keyboard.press('s');
await page.evaluate(() => window._app._setPen('fillShapes', false, true));
const overlapPx = await pixel(cx + 175, cy + 130);
const soloPx = await pixel(cx + 95, cy + 145);   // off the grid lines (every 40px here)
check(overlapPx[3] > 0 && overlapPx.every((v, i) => Math.abs(v - soloPx[i]) <= 3),
  `overlap stays filled, same colour (overlap ${overlapPx.join(',')} vs ${soloPx.join(',')})`);

// Changing colours never touches existing geometry; "Apply drawing style" does.
await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  a.clearSelection();
  a.setSelected(a.project.entitiesOnLayer(ly.id)[0], true);
  a.refreshUI();
});
await page.click('.palette .sw[data-c="#d63a3a"]');
await page.evaluate(() => window._app._setPen('lineStyle', 'center', true));
const untouched = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  return a.project.entitiesOnLayer(ly.id)[0].style;
});
check(untouched.color === '#14946b' && untouched.lineStyle !== 'center', `colour picks leave the selection alone (${JSON.stringify(untouched)})`);
await page.click('#optbar [data-opt="apply-style"]');
const ov = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  return a.project.entitiesOnLayer(ly.id)[0].style;
});
check(ov && ov.color === '#d63a3a' && ov.lineStyle === 'center', `entity style override (${JSON.stringify(ov)})`);
const undoStyle = await page.evaluate(() => {
  const a = window._app; a.undo();
  const ly = a.project.activeLayer();
  return a.project.entitiesOnLayer(ly.id)[0].style;
});
check(undoStyle && undoStyle.lineStyle !== 'center' && undoStyle.color === '#14946b', `style change is undoable (${JSON.stringify(undoStyle)})`);

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

// Lock: geometry on a locked layer can't be picked; hide: can't be snapped either.
const lockHit = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  const line = a.project.entitiesOnLayer(ly.id)[0];
  const mid = { x: (line.p1.x + line.p2.x) / 2, y: (line.p1.y + line.p2.y) / 2 };
  const before = a.hitTestAcrossLayers(mid) === line;
  ly.locked = true;
  const locked = a.hitTestAcrossLayers(mid);
  ly.locked = false; ly.visible = false;
  const snap = a.snap.find(line.p1, a.view, a.visibleSketches());
  ly.visible = true;
  return { before, locked: locked === null, snapHidden: !snap || snap.entity !== line.p1 };
});
check(lockHit.before && lockHit.locked && lockHit.snapHidden, `lock / hide exclude picking and snapping (${JSON.stringify(lockHit)})`);

// Locked layer stays put while a connected line on another layer is dragged.
const lockDrag = await page.evaluate(() => {
  const a = window._app, base = a.project.layers[0];
  const rectLine = a.project.entitiesOnLayer(base.id).find(e => e.constructor.kind === 'line');
  a.project.activeLayerId = a.project.layers[1].id;
  const tool = a.tool; a.setTool('line');
  return { id: rectLine.id, p: [rectLine.p2.x, rectLine.p2.y], baseId: base.id, tool: !!tool };
});
// draw a line starting on the locked rectangle's corner
await page.evaluate(() => { const a = window._app; a.project.layers[0].locked = true; a.commit(); a.refreshUI(); });
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
check(after2.p[0] === lockDrag.p[0] && after2.p[1] === lockDrag.p[1], `locked layer did not move during drag (${JSON.stringify({ before: lockDrag.p, after: after2 })})`);
await page.evaluate(() => { const a = window._app; a.project.layers[0].locked = false; a.commit(); a.refreshUI(); });

// Fill tool: fill the Layer 1 rectangle (boundary on another layer), then the background, then erase.
await page.evaluate(() => window._app._setPen('lineStyle', 'solid', true));
await page.click('.palette .sw[data-c="#8a4fd1"]', { button: 'right' });
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

// Locked active layer: banner shows and drawing is blocked.
await page.evaluate(() => { const a = window._app; a.project.activeLayer().locked = true; a._layerChanged(); });
const nBefore = await page.evaluate(() => window._app.activeSketch().entities.length);
await page.keyboard.press('l');
await page.mouse.click(cx + 120, cy - 120);
await page.mouse.click(cx + 200, cy - 120);
await page.keyboard.press('Escape'); await page.keyboard.press('s');
const lockUi = await page.evaluate(() => ({
  banner: !document.getElementById('lock-banner').hidden,
  row: !!document.querySelector('#layer-list .lyr-row.active.locked .lock-tag'),
  n: window._app.activeSketch().entities.length,
}));
check(lockUi.banner && lockUi.row && lockUi.n === nBefore, `locked layer is obvious and blocks drawing (${JSON.stringify(lockUi)})`);
await page.click('#lock-banner .unlock');
const unlocked = await page.evaluate(() => !window._app.project.activeLayer().locked && document.getElementById('lock-banner').hidden);
check(unlocked, 'banner Unlock button unlocks the layer');

// Colour mode + theme toggles (end in Colors mode for the screenshot).
await page.click('#menubar [data-action="color-mode"]');
await page.click('#menubar [data-action="theme"]');
const prefs = await page.evaluate(() => ({ mode: window._app.renderer.colorMode, theme: document.documentElement.dataset.theme }));
check(prefs.mode === 'status' && prefs.theme === 'dark', `colour mode + theme (${JSON.stringify(prefs)})`);
await page.click('#menubar [data-action="color-mode"]');
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

await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
if (shot) await page.screenshot({ path: shot });
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);

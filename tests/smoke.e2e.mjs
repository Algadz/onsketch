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

await page.addInitScript(() => { try { localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light', colorMode: 'status' })); } catch {} });
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
const input = page.locator('#workspace input');
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

// A rectangle drawn now goes on Layer 2; give the layer a fill from the panel.
await page.keyboard.press('r');
await page.mouse.click(cx + 60, cy + 60);
await page.mouse.click(cx + 200, cy + 160);
await page.keyboard.press('Escape');
await page.keyboard.press('s');
await page.evaluate(() => window._app.clearSelection());
await page.click('#style-body .swatches[data-key="fill"] .sw[data-v="#e07b00"]');
const onLayer2 = await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  return { count: a.project.entitiesOnLayer(ly.id).length, fill: ly.fill };
});
check(onLayer2.count === 4 && onLayer2.fill === '#e07b00', `new geometry on active layer, layer fill set (${JSON.stringify(onLayer2)})`);

// Fill pixels actually painted inside the rectangle.
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const filled = await page.evaluate(([x, y]) => {
  const c = document.getElementById('canvas'), r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const px = c.getContext('2d').getImageData((x - r.left) * d, (y - r.top) * d, 1, 1).data;
  return Array.from(px);
}, [cx + 130, cy + 110]);
check(filled[3] > 0 && filled[0] > filled[2], `fill painted (rgba ${filled.join(',')})`);

// Per-entity override through the selection style panel.
await page.evaluate(() => {
  const a = window._app, ly = a.project.activeLayer();
  a.clearSelection();
  a.setSelected(a.project.entitiesOnLayer(ly.id)[0], true);
  a.refreshUI();
});
await page.click('#style-body .swatches[data-key="color"] .sw[data-v="#d63a3a"]');
await page.selectOption('#style-body select[data-key="lineStyle"]', 'center');
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
check(undoStyle && undoStyle.lineStyle === undefined && undoStyle.color === '#d63a3a', `style change is undoable (${JSON.stringify(undoStyle)})`);

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

// Colour mode + theme toggles.
await page.click('#topbar [data-action="color-mode"]');
await page.click('#topbar [data-action="theme"]');
const prefs = await page.evaluate(() => ({ mode: window._app.renderer.colorMode, theme: document.documentElement.dataset.theme }));
check(prefs.mode === 'layer' && prefs.theme === 'dark', `colour mode + theme (${JSON.stringify(prefs)})`);

await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
if (shot) await page.screenshot({ path: shot });
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);

// End-to-end test: pen / marker / arrow widths and text heights are drawing
// units; the CAD line weight is screen px for the whole sketch, the same at every zoom
// are sizes on the drawing (document unit), the same whatever the zoom.
//
// Usage: node tests/sizes.e2e.mjs [rootDir]
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
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const setZoom = (z) => page.evaluate((z) => { const a = window._app; a.view.zoom = z; a.view.panX = 0; a.view.panY = 0; a.requestRender(); }, z);
const ink = () => page.evaluate(() => window._app.activeSketch().strokes.map(s => ({ kind: s.kind, width: s.width, size: s.size })));
const strokeAt = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 60, y + 20, { steps: 5 }); await page.mouse.up(); };

await page.evaluate(() => { const a = window._app; for (const w of ['colors', 'tools', 'layers', 'equations']) a.windows.toggle(w, false); a.windows.toggle('sketch', true); a.refreshUI(); });

// ---- Pen: the same width at zoom 4 and at zoom 16 ----
await setZoom(4);
await page.keyboard.press('n');
check(await page.isVisible('#sketch-body input[data-size="pen"]') && /mm/.test(await page.textContent('#sketch-body .size-opt')), 'the pen size is a field in mm');
const penSize = +(await page.inputValue('#sketch-body input[data-size="pen"]'));
await strokeAt(cx - 300, cy - 200);
await setZoom(16);
await strokeAt(cx - 300, cy + 100);
let k = await ink();
check(k.length === 2 && k[0].width === k[1].width && k[0].width === penSize, `pen strokes drawn at zoom 4 and 16 are both ${penSize} mm wide (${k.map(s => s.width)})`);
check(+(await page.inputValue('#sketch-body input[data-size="pen"]')) === penSize, 'zooming doesn\'t change the pen size');

// typing a size, with a unit
await page.fill('#sketch-body input[data-size="pen"]', '0.05in');
await page.press('#sketch-body input[data-size="pen"]', 'Enter');
check(Math.abs(await page.evaluate(() => window._app.project.sizes.pen) - 1.27) < 1e-9, '"0.05in" sets the pen to 1.27 mm');

// ---- Text and arrow ----
await setZoom(4);
await page.keyboard.press('t');
await page.mouse.click(cx + 100, cy - 200); await page.keyboard.type('A'); await page.keyboard.press('Enter');
await setZoom(20);
await page.keyboard.press('t');
await page.mouse.click(cx + 100, cy + 150); await page.keyboard.type('B'); await page.keyboard.press('Enter');
k = (await ink()).filter(s => s.kind === 'text');
check(k.length === 2 && k[0].size === k[1].size, `texts written at zoom 4 and 20 have the same height (${k.map(s => s.size)} mm)`);
await setZoom(4);
await page.keyboard.press('w');
await page.mouse.move(cx - 100, cy + 250); await page.mouse.down(); await page.mouse.move(cx - 20, cy + 230, { steps: 4 }); await page.mouse.up();
await setZoom(10);
await page.mouse.move(cx - 100, cy - 250); await page.mouse.down(); await page.mouse.move(cx - 20, cy - 230, { steps: 4 }); await page.mouse.up();
k = (await ink()).filter(s => s.kind === 'arrow');
check(k.length === 2 && k[0].width === k[1].width, `arrows drawn at two zooms are the same width (${k.map(s => s.width)})`);

// ---- Geometry line weight ----
await page.keyboard.press('Escape');
await setZoom(4);
await page.keyboard.press('l');
check(await page.isVisible('#optbar input[data-size="linePx"]') && /px/.test(await page.textContent('#optbar .size-opt')), 'the options bar has the line weight in px');
await page.mouse.click(cx - 200, cy); await page.mouse.click(cx + 200, cy);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
const lw = await page.evaluate(() => { const a = window._app; a._render(); const l = a.activeSketch().entities.find(e => e.constructor.kind === 'line'); return { own: l.style?.lineWidth, w: a.project.sizes.linePx, px: a.renderer.styleFor(l, true).width }; });
check(lw.own === undefined && lw.w === 1.4 && Math.abs(lw.px - 1.4) < 1e-9, `a new line has the sketch's weight, 1.4 px (${lw.px} px)`);
const px = (z) => page.evaluate((z) => { const a = window._app; a.view.zoom = z; a._render(); const l = a.activeSketch().entities.find(e => e.constructor.kind === 'line'); return a.renderer.styleFor(l, true).width; }, z);
const p4 = await px(4), p8 = await px(8), tiny = await px(0.001);
check(p4 === 1.4 && p8 === 1.4 && tiny === 1.4, `the same width on screen at every zoom (${p4} / ${p8} / ${tiny} px at 100 %, 200 %, far out)`);
// the weight is the whole sketch's: a second line, then change it from
// Properties with nothing selected
await setZoom(4);
await page.keyboard.press('l');
await page.mouse.click(cx - 200, cy + 60); await page.mouse.click(cx + 200, cy + 60);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
await page.keyboard.press('s');
await page.evaluate(() => { const a = window._app; a.clearSelection(); a.windows.toggle('props', true); a.refreshUI(); });
check(/Sketch/.test(await page.textContent('#sel-body')) && await page.isVisible('#sel-body input[data-size="linePx"]'), 'with nothing selected, Properties shows the Sketch line weight');
await page.fill('#sel-body input[data-size="linePx"]', '3px');
await page.press('#sel-body input[data-size="linePx"]', 'Enter');
const all = await page.evaluate(() => { const a = window._app; a.view.zoom = 4; a._render(); return a.activeSketch().entities.filter(e => e.constructor.kind === 'line').map(l => a.renderer.styleFor(l, true).width); });
check(all.length === 2 && all.every(w => Math.abs(w - 3) < 1e-9), `"3px": every line of the sketch is 3 px, at once (${all.join(', ')})`);
// ---- Saved with the document ----
const saved = await page.evaluate(() => window._app.project.toJSON().sizes);
check(saved.linePx === 3 && Math.abs(saved.pen - 1.27) < 1e-9, `sizes are saved with the document (${JSON.stringify(saved)})`);

// ---- km document: sizes in km ----
await page.evaluate(() => { const a = window._app; a.project = new a.project.constructor(); a.project.addSketch('S'); a.project.units = 'km'; a._syncUnits(); a.view.zoom = 0.003; a.refreshUI(); });
await page.keyboard.press('n');
const kmPen = await page.inputValue('#sketch-body input[data-size="pen"]');
check(/km/.test(await page.textContent('#sketch-body .size-opt')) && +kmPen >= 100, `in a km drawing the pen size is in km (${kmPen} km)`);

// ---- An older file (pixel weights) ----
await page.evaluate(() => {
  const a = window._app, P = (id, x, y) => ({ type: 'point', id, x, y });
  a.project = a.project.constructor.fromJSON({ version: 3, activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }],
    sketches: [{ id: 's', name: 'S', entities: [{ type: 'line', id: 'a', p1: P('p', 0, 0), p2: P('q', 400, 0), style: { lineWidth: 2 } }], constraints: [] }] });
  a._afterStateSwap(); a.view.zoom = 4;
});
const old = await page.evaluate(() => { const a = window._app, l = a.activeSketch().entities[0]; a._render(); return { w: a.project.sizes.linePx, px: a.renderer.styleFor(l, true).width }; });
check(old.w === 2 && Math.abs(old.px - 2) < 1e-9, `an older 2 px line is the sketch weight, 2 px (${old.px} px)`);

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

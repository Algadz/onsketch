// End-to-end test: the Shapes tool (U) draws rectangles, ellipses, stars…
// as ink: pick a shape in the Sketch window, drag a box (Shift: equal
// sides, Ctrl: from the middle); the new shape is selected and restyled by
// the controls; fill, line and outline width; Properties; box handles;
// saved with the drawing; eraser; undo.
//
// Usage: node tests/shapes.e2e.mjs [rootDir]
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
const SHOT = process.env.SHOT;
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
await page.evaluate(() => { const a = window._app; for (const w of ['colors', 'tools', 'layers', 'equations']) a.windows.toggle(w, false); a.windows.toggle('sketch', true); a.windows.toggle('props', true); a.view.zoom = 4; a.view.panX = 0; a.view.panY = 0; a.refreshUI(); a.requestRender(); });
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const shapes = () => page.evaluate(() => window._app.activeSketch().strokes.filter(s => s.kind === 'shape').map(s => ({ shape: s.shape, fill: s.fill || 'none', dash: !!s.dash, width: s.width, sel: !!s.selected, pts: s.points.map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]) })));
const drag = async (x0, y0, x1, y1, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 6 }); await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
};
await page.evaluate(() => { window._app.snapOn = false; });

// ---- The tool and the picker ----
await page.keyboard.press('u');
check(await page.evaluate(() => window._app.toolName) === 'shape', 'U takes the Shapes tool');
check(await page.locator('#sketch-body [data-shape]').count() === 12, 'the Sketch window offers 12 shapes');
check(await page.isVisible('#sketch-body input[data-size="shape"]') && /mm/.test(await page.innerText('#sketch-body .size-opt')), 'the outline width is a field in mm');

// ---- A rectangle: drag a box ----
await drag(cx - 300, cy - 200, cx - 140, cy - 120);
let k = await shapes();
check(k.length === 1 && k[0].shape === 'rect' && k[0].sel, `a drag draws a rectangle, selected (${JSON.stringify(k[0]?.pts)})`);
check(k[0] && Math.abs(k[0].pts[1][0] - k[0].pts[0][0] - 40) < 0.01 && Math.abs(k[0].pts[0][1] - k[0].pts[2][1] - 20) < 0.01, 'it fills the dragged box (40 × 20 mm at 100 %)');
// restyle the selected one from the window
await page.click('#sketch-body [data-shapestyle="fill:tint"]');
await page.click('#sketch-body [data-shapestyle="dash:true"]');
k = await shapes();
check(k[0].fill === 'tint' && k[0].dash, 'Fill and Line restyle the shape just drawn');
check(await page.evaluate(() => window._app.pen.shapeFill === 'tint'), 'and become the next shape\'s style');

// ---- An ellipse with Shift: a circle ----
await page.click('#sketch-body [data-shape="ellipse"]');
await drag(cx - 60, cy - 200, cx + 60, cy - 160, ['Shift']);
k = await shapes();
const e = k[1];
check(e && e.shape === 'ellipse' && Math.abs((e.pts[1][0] - e.pts[0][0]) - (e.pts[0][1] - e.pts[2][1])) < 0.01, `Shift: a circle (${JSON.stringify(e?.pts)})`);
check(k[0].shape === 'rect' && !k[0].sel && e.sel, 'picking another shape leaves the rectangle a rectangle, and deselects it');

// ---- A star from the middle (Ctrl) ----
await page.click('#sketch-body [data-shape="star"]');
await drag(cx + 200, cy - 160, cx + 260, cy - 100, ['Control']);
k = await shapes();
const st = k[2];
check(st && st.shape === 'star' && Math.abs((st.pts[0][0] + st.pts[1][0]) / 2 - (st.pts[0][0] + (200 / 4))) > -1 && Math.abs(st.pts[1][0] - st.pts[0][0] - 30) < 0.01, `Ctrl: drawn from the middle, twice as big (${JSON.stringify(st?.pts)})`);

// ---- More shapes for the picture ----
const more = ['rounded', 'triangle', 'diamond', 'pentagon', 'hexagon', 'heart', 'callout', 'check', 'cross'];
for (let i = 0; i < more.length; i++) {
  await page.click(`#sketch-body [data-shape="${more[i]}"]`);
  if (i === 1) await page.click('#sketch-body [data-shapestyle="fill:solid"]');
  if (i === 2) await page.click('#sketch-body [data-shapestyle="dash:false"]');
  if (i === 3) await page.click('#sketch-body [data-shapestyle="fill:none"]');
  const x = cx - 320 + (i % 5) * 140, y = cy + (i < 5 ? -40 : 90);
  await drag(x, y, x + 100, y + 80);
}
k = await shapes();
check(k.length === 12 && new Set(k.map(s => s.shape)).size === 12, `all 12 shapes drawn (${k.map(s => s.shape).join(', ')})`);
check(await page.evaluate(() => document.querySelector('#sketch-body [data-shapestyle="fill:tint"]')?.disabled), 'a check mark or cross offers no fill');
await page.keyboard.press('Escape');
if (SHOT) await page.screenshot({ path: SHOT + '-canvas.png' });

// ---- Select a shape: Properties ----
await page.keyboard.press('s');
await page.mouse.click(cx - 300, cy - 160);          // the rectangle's left side
let sel = await page.evaluate(() => window._app.selectedStrokes().map(s => s.shape));
check(sel.length === 1 && sel[0] === 'rect', `clicking the outline selects the rectangle (${sel})`);
check(/rectangle/i.test(await page.innerText('#sel-body')) && await page.isVisible('#sel-body [data-ink-shape="rect"].on'), 'Properties shows the shape, with its picker on Rectangle');
check(await page.isVisible('#sketch-body [data-shapestyle]') && !(await page.isVisible('#sketch-body [data-shape]')), 'the Sketch window shows the selected shape\'s style, without the next-shape picker');
check(!(await page.isVisible('#optbar [data-opt-shape]')) && await page.isVisible('#optbar [data-opt-shapestyle]'), 'so does the options bar');
if (SHOT) await page.screenshot({ path: SHOT + '-props.png' });
await page.click('#sel-body [data-ink-shape="hexagon"]');
check((await shapes())[0].shape === 'hexagon', 'Properties turns the rectangle into a hexagon');
await page.fill('#sel-body input[data-ink-k="imgW"]', '60');
await page.press('#sel-body input[data-ink-k="imgW"]', 'Enter');
k = await shapes();
check(Math.abs(k[0].pts[1][0] - k[0].pts[0][0] - 60) < 0.01, 'box width 60 mm');
// the outline width from the Sketch window size field
await page.fill('#sketch-body input[data-size="shape"]', '1.5');
await page.press('#sketch-body input[data-size="shape"]', 'Enter');
check((await shapes())[0].width === 1.5, 'the outline field sets the selected shape\'s width');
// the colour
await page.evaluate(() => { const a = window._app; a.windows.toggle('colors', true); a.refreshUI(); });
await page.click('#colors-body .palette .sw:nth-child(3)');
const col = await page.evaluate(() => window._app.selectedStrokes()[0].color);
check(col === await page.evaluate(() => document.querySelector('#colors-body .palette .sw:nth-child(3)').dataset.c), 'a colour swatch recolours it');

// ---- Inside of an unfilled shape doesn't select it; a filled one does ----
await page.keyboard.press('Escape');
const hit = (x, y) => page.evaluate(([x, y]) => { const a = window._app, b = a.canvas.getBoundingClientRect(); const w = a.view.screenToWorld({ x: x - b.left, y: y - b.top }); return a.hitStrokeAt(w)?.shape || null; }, [x, y]);
check(await hit(cx - 320 + 140 + 50, cy - 40 + 40) === 'triangle', 'the inside of a solid triangle selects it');
check(await hit(cx, cy - 180) === 'ellipse', 'the inside of the tinted circle selects it');
check(await hit(cx - 320 + 3 * 140 + 50, cy - 40 + 45) === null, 'the inside of an unfilled pentagon doesn\'t');

// ---- Saved with the drawing ----
const json = await page.evaluate(() => JSON.stringify(window._app.project.toJSON()));
const back = await page.evaluate((j) => { const a = window._app; const P = a.project.constructor.fromJSON(JSON.parse(j)); return P.sketches[0].strokes.filter(s => s.kind === 'shape').length; }, json);
check(back === 12, 'shapes are saved and loaded with the drawing');

// ---- Undo ----
const n0 = (await shapes()).length;
await page.evaluate(() => window._app.undo());
check((await shapes()).length === n0, 'undo steps back through restyles first (still 12 shapes)');

// ---- Eraser removes a shape ----
await page.keyboard.press('e');
const before = (await shapes()).length;
const ex = cx - 320 + 4 * 140, ey = cy - 40;
await drag(ex, ey + 40, ex + 100, ey + 40);
check((await shapes()).length === before - 1, 'the eraser removes a shape it touches');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

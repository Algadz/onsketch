// End-to-end test: a slider on the sketch for a global variable
// (app/sliders.js): added from the Equations window, dragged (the sketch
// follows live), typed, moved, ranged in Properties, saved, exported as a
// label, removed with Delete (the variable stays).
//
// Usage: node tests/sliders.e2e.mjs [rootDir]
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
// A line whose length is the variable L (=L on its dimension).
await page.evaluate(() => {
  const a = window._app, P = (id, x, y) => ({ type: 'point', id, x, y });
  a.project = a.project.constructor.fromJSON({ version: 5, units: 'mm', activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }], variables: [{ name: 'L', expr: '40' }],
    sketches: [{ id: 's', name: 'S', entities: [{ type: 'line', id: 'ln', p1: P('o', 0, 0), p2: P('q', 40, 0) }],
      constraints: [{ id: 'f', kind: 'fix', pointId: 'o', x: 0, y: 0 }, { id: 'h', kind: 'horizontal', lineId: 'ln', p1: 'o', p2: 'q' },
        { id: 'd', kind: 'distance', p1: 'o', p2: 'q', value: 40, name: 'D1', expr: 'L' }] }] });
  a._afterStateSwap();
  for (const w of ['colors', 'tools', 'sketch', 'layers']) a.windows.toggle(w, false);
  a.windows.toggle('equations', true); a.windows.toggle('props', true);
  a.view.zoom = 6; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.refreshUI(); a._render();
});
const len = () => page.evaluate(() => { const q = window._app._lookupAny('q'); return +q.x.toFixed(4); });
const L = () => page.evaluate(() => window._app.project.variables[0].expr);

// ---- Add it from the Equations window ----
await page.click('#equations-body [data-eq="slider"]');
const sl = await page.evaluate(() => { const v = window._app.project.variables[0]; window._app._render(); return { slider: v.slider, sel: window._app._sliderSel, rects: (window._app._sliderRects || []).length }; });
check(sl.slider && sl.slider.min === 0 && sl.slider.max === 100 && sl.rects === 1, `⊸ in the Equations window adds a slider, 0 to 100 for 40 (${JSON.stringify(sl.slider)})`);
check(sl.sel === 'L' && /Slider/.test(await page.innerText('#sel-body')), 'the new slider is selected: Properties shows its range');
check(await page.getAttribute('#equations-body [data-eq="slider"]', 'aria-pressed') === 'true', 'the button shows it is on');

// ---- Drag the knob: the sketch follows before release; one undo step ----
const box = await page.evaluate(() => { const a = window._app, b = a._sliderBox(a.project.variables[0]), r = a.canvas.getBoundingClientRect(); return { x0: r.left + b.track.x0, x1: r.left + b.track.x1, y: r.top + b.track.y, kx: r.left + b.track.x0 + 0.4 * (b.track.x1 - b.track.x0) }; });
await page.mouse.move(box.kx, box.y); await page.mouse.down();
await page.mouse.move(box.x0 + 0.7 * (box.x1 - box.x0), box.y, { steps: 8 });
const live = { L: await L(), len: await len() };
check(Math.abs(Number(live.L) - 70) <= 1 && Math.abs(live.len - Number(live.L)) < 1e-6, `dragging the knob to 70 %: L = ${live.L}, the line is ${live.len} long before release`);
const undoBefore = await page.evaluate(() => window._app.undoStack.length);
await page.mouse.up();
check(await page.evaluate(() => window._app.undoStack.length) === undoBefore + 1, 'release: one undo step');
await page.evaluate(() => { window._app.undo(); window._app._render(); });
check(await L() === '40' && await len() === 40, 'undo puts L and the line back to 40');
// press on the track: jumps there
await page.mouse.click(box.x0 + 0.25 * (box.x1 - box.x0), box.y);
check(Math.abs(Number(await L()) - 25) <= 1, `a press on the track jumps there (L = ${await L()})`);

// ---- Type a value; move the slider by its name ----
await page.evaluate(() => window._app._render());
const vbox = await page.evaluate(() => { const a = window._app, b = a._sliderBox(a.project.variables[0]), r = a.canvas.getBoundingClientRect(); return { x: r.left + b.value.x + b.value.w / 2, y: r.top + b.y + b.h / 2, nx: r.left + b.x + 20, ny: r.top + b.y + 15 }; });
await page.mouse.click(vbox.x, vbox.y);
await page.waitForSelector('.dim-input');
await page.fill('.dim-input', '55'); await page.keyboard.press('Enter');
check(await L() === '55' && await len() === 55, 'click the value, type 55: L = 55');
const at0 = await page.evaluate(() => ({ ...window._app.project.variables[0].slider }));
await page.mouse.move(vbox.nx, vbox.ny); await page.mouse.down(); await page.mouse.move(vbox.nx + 60, vbox.ny + 30, { steps: 6 }); await page.mouse.up();
const at1 = await page.evaluate(() => ({ ...window._app.project.variables[0].slider }));
check(at1.x > at0.x && at1.y < at0.y && await L() === '55', 'dragging its name moves the slider (the value stays)');

// ---- Properties: range ----
await page.mouse.click(vbox.nx + 60, vbox.ny + 30);
await page.fill('#sel-body input[data-slider="max"]', '200'); await page.press('#sel-body input[data-slider="max"]', 'Enter');
check(await page.evaluate(() => window._app.project.variables[0].slider.max) === 200, 'Properties sets the max');

// ---- Saved; exported as a label ----
const back = await page.evaluate(() => { const a = window._app; return a.project.constructor.fromJSON(JSON.parse(JSON.stringify(a.project.toJSON()))).variables[0].slider; });
check(back && back.max === 200 && back.step > 0, 'saved and loaded with the variable');
const svg = await page.evaluate(async () => { const m = await import('/app/src/render/export.js'); return m.exportSVG(window._app._exportSource(), { dimensions: false }); });
check(/>L</.test(svg) && /= 55 mm/.test(svg), 'an SVG export shows it as a label: L … = 55 mm');

// ---- Delete removes the slider, not the variable ----
await page.evaluate(() => { const a = window._app; a.clearSelection(); a._sliderSel = 'L'; a.refreshUI(); });
await page.mouse.move(5, 5); await page.click('#canvas', { position: { x: 5, y: 300 }, modifiers: [] }).catch(() => {});
await page.evaluate(() => { const a = window._app; a._sliderSel = 'L'; a.deleteSelection(); });
const after = await page.evaluate(() => ({ vars: window._app.project.variables.map(v => v.name + (v.slider ? '+slider' : '')).join() }));
check(after.vars === 'L', `Delete removes the slider; the variable L stays (${after.vars})`);

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

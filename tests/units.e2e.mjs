// End-to-end test of document units (km: Earth to Moon) and formulas in
// text ({D1}, {orbit:1}): typed units convert, zoom fits, print scale,
// DXF units, click a dimension while typing a text to insert it.
// Usage: node tests/units.e2e.mjs [rootDir]
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

// ---- The unit picker ----
check(await page.locator('#doc-units').inputValue() === 'mm', 'a new sketch is in mm');
await page.selectOption('#doc-units', 'km');          // empty sketch: no question
check(await page.evaluate(() => window._app.project.units) === 'km', 'picking km sets the document unit');

// Earth and Moon, 384 400 km apart, sized by variables.
const P = (id, x, y) => ({ type: 'point', id, x, y });
await page.evaluate((proj) => {
  const a = window._app;
  a.project = a.project.constructor.fromJSON(proj);
  a._afterStateSwap();
  a.commit({ diagnostics: 'sync' });
  for (const w of ['colors', 'tools', 'sketch', 'layers']) a.windows.toggle(w, false);
  a.windows.toggle('equations', true);
  a.refreshUI();
}, { version: 3, units: 'km', activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }],
  variables: [{ name: 'moon', expr: '384400' }],
  sketches: [{ id: 's', name: 'S', entities: [
    { type: 'circle', id: 'earth', center: P('o', 0, 0), r: 6000 },
    { type: 'circle', id: 'luna', center: P('m', 380000, 0), r: 2000 },
    { type: 'line', id: 'axis', construction: true, p1: P('o', 0, 0), p2: P('m', 380000, 0) },
  ], constraints: [
    { id: 'f', kind: 'fix', pointId: 'o', x: 0, y: 0 },
    { id: 'h', kind: 'horizontal', lineId: 'axis', p1: 'o', p2: 'm' },
    { id: 'd1', kind: 'radius', circleId: 'earth', value: 6000, name: 'D1', expr: '6371' },
    { id: 'd2', kind: 'radius', circleId: 'luna', value: 2000, name: 'D2', expr: '1737.4' },
    { id: 'd3', kind: 'distance', p1: 'o', p2: 'm', value: 380000, name: 'D3', expr: 'moon' },
  ],
  strokes: [{ id: 'k1', layerId: 'l', kind: 'text', color: '#111418', opacity: 1, size: 8000, text: 'Moon at {D3} km, {D3/D1:1} Earth radii\n{{literal}}', pts: [0, 60000] }] }] });
await page.evaluate(() => window._app.zoomFit());
let g = await page.evaluate(() => {
  const a = window._app, s = a.activeSketch(), e = s.entities.find(x => x.id === 'earth'), m = s.entities.find(x => x.id === 'luna');
  return { re: e.r, rm: m.r, d: m.center.x - e.center.x, state: document.getElementById('status-state').textContent, unit: document.getElementById('doc-units').value,
    zoom: a.view.zoom, zoomText: document.getElementById('status-zoom').textContent };
});
check(g.re === 6371 && g.rm === 1737.4 && Math.abs(g.d - 384400) < 1e-6, `Earth r 6371 km, Moon r 1737.4 km, 384 400 km apart (${g.d})`);
check(!/Over/.test(g.state), `solved (${g.state})`);
check(g.unit === 'km', 'the menu bar shows km for the loaded sketch');
check(g.zoom < 0.01 && g.zoom > 1e-4, `Zoom to fit reaches the Moon (zoom ${g.zoom.toExponential(2)} px/km)`);
const onScreen = await page.evaluate(() => { const a = window._app, s = a.activeSketch(), m = s.entities.find(x => x.id === 'luna'); const p = a.view.worldToScreen(m.center); return p.x > 0 && p.x < a.view.cssW; });
check(onScreen, 'both bodies are in view');

// typed units convert into km
await page.evaluate(() => { const a = window._app, c = a.activeSketch().constraints.find(k => k.name === 'D2'); a.setDimensionFromText(c, '3474800m / 2'); });
g = await page.evaluate(() => window._app.activeSketch().entities.find(x => x.id === 'luna').r);
check(Math.abs(g - 1737.4) < 1e-9, `"3474800m / 2" is 1737.4 km (${g})`);
await page.evaluate(() => { const a = window._app, c = a.activeSketch().constraints.find(k => k.name === 'D2'); a.setDimensionFromText(c, '1079.6mi'); });
g = await page.evaluate(() => window._app.activeSketch().entities.find(x => x.id === 'luna').r);
check(Math.abs(g - 1079.6 * 1.609344) < 1e-6, `miles convert too (${g.toFixed(3)} km)`);

// ---- Formulas in text ----
const shown = () => page.evaluate(() => { const a = window._app; return a.textShown(a.activeSketch().strokes[0]); });
check(await shown() === 'Moon at 384400 km, 60.3 Earth radii\n{literal}', `a text shows its formulas' values (${JSON.stringify(await shown())})`);
await page.locator('#equations-body input[data-k="var-expr"]').first().fill('405500');
await page.locator('#equations-body input[data-k="var-expr"]').first().press('Enter');
check((await shown()).startsWith('Moon at 405500 km, 63.6'), `changing the variable updates the text (${(await shown()).split('\n')[0]})`);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
const raw = await page.evaluate(() => window._app.activeSketch().strokes[0].text);
check(raw.startsWith('Moon at {D3} km'), 'the text keeps its formulas');
// a bad field
await page.evaluate(() => { const a = window._app, t = a.activeSketch().strokes[0]; t.text = 'x {nope} y'; a.commit(); });
check(await shown() === 'x #? y', `an unknown name shows #? (${await shown()})`);

// typing a text: click a dimension to insert {D1}
await page.evaluate(() => { const a = window._app, t = a.activeSketch().strokes[0]; t.text = 'Earth '; a.commit(); a.setTool('text'); a.editText(t); });
await page.waitForSelector('textarea.text-edit');
await page.locator('textarea.text-edit').press('End');
const d1 = await page.evaluate(async () => {
  const a = window._app; a.requestRender(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = a.renderer.lastDimRects.find(r => r.constraint.name === 'D1'), c = a.canvas.getBoundingClientRect();
  return r && { x: c.left + r.x + r.w / 2, y: c.top + r.y + r.h / 2 };
});
check(!!d1, 'D1 is on screen');
if (d1) await page.mouse.click(d1.x, d1.y);
check(await page.locator('textarea.text-edit').inputValue() === 'Earth {D1}', `clicking D1 while typing inserts {D1} (${await page.locator('textarea.text-edit').inputValue()})`);
await page.keyboard.type(' km');
await page.keyboard.press('Enter');
check(await shown() === 'Earth 6371 km', `and the text shows it (${await shown()})`);

// ---- Changing the unit of a drawing asks, and relabels ----
await page.selectOption('#doc-units', 'm');
await page.waitForSelector('.app-dialog');
check(/numbers stay/i.test(await page.textContent('.app-dialog')), 'changing the unit of a drawing explains what happens');
await page.click('.app-dialog button:has-text("Cancel")');
check(await page.locator('#doc-units').inputValue() === 'km' && await page.evaluate(() => window._app.project.units) === 'km', 'Cancel keeps km');

// ---- Export: print scale and DXF units ----
const out = await page.evaluate(async () => {
  const a = window._app;
  return { saved: a.project.toJSON().units };
});
check(out.saved === 'km', 'the unit is saved with the sketch');
await page.click('#menubar [data-action="export"]');
await page.waitForSelector('[data-opt="scale"] option', { state: 'attached' });
const opt = await page.textContent('[data-opt="scale"] option');
check(/Auto \(1:[\d ]{9,}\)/.test(opt), `print scale for a km drawing is huge (${opt})`);
check(/kilometres/.test(await page.textContent('[data-note="scale"]')), 'the export says DXF is in kilometres');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

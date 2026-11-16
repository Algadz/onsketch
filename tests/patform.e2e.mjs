// End-to-end test of formulas in pattern fields: =D1/2, =n, click a dimension
// to insert it, the value under the field, the Patterns rows of the Equations
// window, and copies following their variables (linear and circular).
// Usage: node tests/patform.e2e.mjs [rootDir]
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
const P = (id, x, y) => ({ type: 'point', id, x, y });
const load = () => page.evaluate((proj) => {
  const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
  a.view.zoom = 6; a.view.panX = -200; a.view.panY = 0;
  a.commit({ diagnostics: 'sync' });
  for (const w of ['colors', 'tools', 'sketch', 'layers']) a.windows.toggle(w, false);
  a.windows.toggle('props', true); a.windows.toggle('equations', true);
  a.refreshUI();
}, { version: 3, activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }], variables: [{ name: 'n', expr: '4' }],
  sketches: [{ id: 's', name: 'S', entities: [
    { type: 'circle', id: 'c', center: P('o', 0, 0), r: 3 },
    { type: 'line', id: 'L', p1: P('a', 0, -25), p2: P('b', 30, -25) },
  ], constraints: [{ id: 'd1', kind: 'distance', p1: 'a', p2: 'b', value: 30, name: 'D1', labelOffset: -6 }] }] });
const circles = () => page.evaluate(() => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'circle').map(c => +c.center.x.toFixed(6)).sort((x, y) => x - y));
const dimAt = (name) => page.evaluate(async (name) => {
  const a = window._app; a.requestRender(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = a.renderer.lastDimRects.find(r => r.constraint.name === name), c = a.canvas.getBoundingClientRect();
  return r && { x: c.left + r.x + r.w / 2, y: c.top + r.y + r.h / 2 };
}, name);

// ---- Linear ----
await load();
await page.evaluate(() => {
  const a = window._app;
  a.startPatternOperation('linear');
  a.handlePatternPick(a.activeSketch().entities.find(e => e.id === 'c'), { x: 0, y: 0 });
  a.refreshToolOptions();
});
check(/formulas/i.test(await page.textContent('.pat-formula-hint')), 'the pattern panel says fields take formulas');
const spacing = page.locator('[data-pfield="d1.spacing"]');
await spacing.click();
await spacing.fill('=');
const d1 = await dimAt('D1');
await page.mouse.click(d1.x, d1.y);
check(await spacing.inputValue() === '=D1', `clicking dimension D1 inserts =D1 in Spacing (${await spacing.inputValue()})`);
await page.keyboard.type('/2');
check((await page.textContent('[data-pval="d1.spacing"]')).trim() === '= 15 mm', `the field shows its value (${(await page.textContent('[data-pval="d1.spacing"]')).trim()})`);
await page.keyboard.press('Enter');
const count = page.locator('[data-pfield="d1.count"]');
await count.fill('=n');
await count.press('Enter');
check((await page.textContent('[data-pval="d1.count"]')).trim() === '= 4', 'Instances =n shows = 4');
check(await page.evaluate(() => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'circle').length) === 1, 'a shape click while a pattern field is focused still picks (nothing inserted, nothing created yet)');
await page.click('#pattern-create');
check(JSON.stringify(await circles()) === JSON.stringify([0, 15, 30, 45]), `4 copies 15 apart (${await circles()})`);
// the variable drives the count, the dimension the spacing
const nField = page.locator('#equations-body input[data-k="var-expr"]').first();
await nField.fill('6'); await nField.press('Enter');
check((await circles()).length === 6, `n = 6 → 6 instances (${(await circles()).length})`);
await page.evaluate(() => { const a = window._app; a.setDimensionFromText(a.activeSketch().constraints.find(c => c.name === 'D1'), '40'); });
check(JSON.stringify(await circles()) === JSON.stringify([0, 20, 40, 60, 80, 100]), `D1 = 40 → spacing 20 (${await circles()})`);
// the Equations window lists the pattern's parameters, editable
const rows = await page.evaluate(() => [...document.querySelectorAll('#equations-body .eq-pat')].map(e => e.textContent));
check(rows.some(r => /Linear 1 · Instances/.test(r)) && rows.some(r => /Spacing/.test(r)), `the Equations window lists the pattern (${rows.join(' | ')})`);
const spRow = page.locator('#equations-body input[data-k="pat-expr"][data-path="d1.spacing"]');
check(await spRow.inputValue() === '=D1/2', 'with its formula');
await spRow.fill('=D1/4'); await spRow.press('Enter');
check(JSON.stringify(await circles()) === JSON.stringify([0, 10, 20, 30, 40, 50]), `editing it there moves the copies (${await circles()})`);

// ---- Circular ----
await load();
await page.evaluate(() => {
  const a = window._app;
  a.startPatternOperation('circular');
  a.handlePatternPick(a.activeSketch().entities.find(e => e.id === 'c'), { x: 0, y: 0 });
  a.setPatternPick('center');
  a.handlePatternPick(null, { x: 0, y: -40 });
  a.refreshToolOptions();
});
await page.locator('[data-pfield="count"]').fill('=n*2');
await page.locator('[data-pfield="count"]').press('Enter');
await page.locator('[data-pfield="angle"]').fill('=360');
await page.locator('[data-pfield="angle"]').press('Enter');
await page.click('#pattern-create');
const ncirc = () => page.evaluate(() => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'circle').length);
check(await ncirc() === 8, `circular: Instances =n*2 → 8 (${await ncirc()})`);
await nField.fill('3'); await nField.press('Enter');
check(await ncirc() === 6, `n = 3 → 6 around the centre (${await ncirc()})`);
const angRow = page.locator('#equations-body input[data-k="pat-expr"][data-path="angle"]');
await angRow.fill('=180'); await angRow.press('Enter');
const spread = await page.evaluate(() => {
  const s = window._app.activeSketch(), cs = s.entities.filter(e => e.constructor.kind === 'circle');
  // angle of each copy around the centre (0, -40), from the seed (at 90°)
  const ang = cs.map(c => ((Math.atan2(c.center.y + 40, c.center.x) * 180 / Math.PI - 90) % 360 + 360) % 360);
  const around = ang.map(a => (a > 359.999 ? 0 : a));
  return Math.max(...around) - Math.min(...around);
});
check(Math.abs(spread - 180) < 1e-6, `Total angle =180 from the Equations window (spread ${spread.toFixed(3)}°)`);

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

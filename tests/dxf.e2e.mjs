// End-to-end test: DXF import (OnSketch Pro): the Import button, the Pro
// prompt for free accounts, a file picked or dropped comes in as a part at
// real size (joined, its own layer, selected, one undo step), units
// converted, what isn't read is said.
//
// Usage: node tests/dxf.e2e.mjs [rootDir]
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
await page.addInitScript(() => { try { localStorage.setItem('onsketch:guide', 'done'); localStorage.setItem('onsketch:tour', 'done'); } catch {} });
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const D = (ents, units = 4) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF'].join('\r\n');
// a 60 × 20 mm slot (round ends), a 4 mm hole, and a text
const slot = D(['0', 'LWPOLYLINE', '8', 'CUT', '90', '4', '70', '1', '10', '0', '20', '-10', '10', '60', '20', '-10', '42', '1', '10', '60', '20', '10', '10', '0', '20', '10', '42', '1',
  '0', 'CIRCLE', '8', 'HOLES', '10', '30', '20', '0', '40', '2', '0', 'TEXT', '8', '0', '1', 'label']);
const shapes = () => page.evaluate(() => window._app.activeSketch().entities.map(e => e.constructor.kind));

// ---- Free: Pro badge, prompt ----
const free = await page.evaluate(() => ({ cloud: window._app.cloudEnabled, locked: document.querySelector('#menubar [data-action="import-dxf"]').classList.contains('pro-locked') }));
check(free.cloud && free.locked, 'free / signed out: the Import button carries a Pro badge');
await page.click('#menubar [data-action="import-dxf"]');
await page.waitForSelector('.app-dialog');
check(/DXF import is part of OnSketch Pro/.test(await page.textContent('.app-dialog')), 'free: Import opens the "part of OnSketch Pro" prompt');
await page.click('.app-dialog button:has-text("Not now")');

// ---- Pro: pick a file ----
await page.evaluate(() => { const a = window._app; a.cloudPlan = { plan: 'premium' }; a._refreshProBadges(); });
check(!(await page.evaluate(() => document.querySelector('#menubar [data-action="import-dxf"]').classList.contains('pro-locked'))), 'Pro: no badge');
const undo0 = await page.evaluate(() => window._app.undoStack.length);
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#menubar [data-action="import-dxf"]')]);
await chooser.setFiles({ name: 'slot plate.dxf', mimeType: 'application/dxf', buffer: Buffer.from(slot) });
await page.waitForFunction(() => window._app.activeSketch().entities.length > 0);
const k = (await shapes()).sort().join(',');
check(k === 'arc,arc,circle,line,line', `the slot (2 lines, 2 arcs) and the hole come in (${k})`);
const res = await page.evaluate(() => { const a = window._app, s = a.activeSketch();
  const arc = s.entities.find(e => e.constructor.kind === 'arc'), c = s.entities.find(e => e.constructor.kind === 'circle'), lines = s.entities.filter(e => e.constructor.kind === 'line');
  return { r: arc.r, hole: c.r, len: Math.hypot(lines[0].p2.x - lines[0].p1.x, lines[0].p2.y - lines[0].p1.y), joins: s.constraints.filter(x => /oincident/.test(x.kind)).length,
    selected: s.entities.every(e => e.selected), layers: a.project.layers.map(l => l.name), undo: a.undoStack.length, msg: document.getElementById('app-notice')?.textContent || '' }; });
check(Math.abs(res.r - 10) < 1e-6 && Math.abs(res.hole - 2) < 1e-6 && Math.abs(res.len - 60) < 1e-6, `at real size: slot ends r 10, hole r 2, sides 60 (${res.r}, ${res.hole}, ${res.len})`);
check(res.joins === 4, `its 4 corners are joined (${res.joins} relations)`);
check(res.selected && res.layers.some(l => /slot plate: CUT/.test(l)) && res.layers.some(l => /slot plate: HOLES/.test(l)), `selected, on its own layers (${res.layers.join(' | ')})`);
check(res.undo === undo0 + 1, 'one undo step');
check(/imported: 5 shapes/.test(res.msg) && /1 text/.test(res.msg), `the note says what came in, and that the text wasn't read ("${res.msg.slice(0, 110)}…")`);
await page.evaluate(() => { window._app.undo(); });
check((await shapes()).length === 0, 'undo takes it all out');

// ---- Inches, dropped on the canvas ----
const inch = D(['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '2', '21', '0'], 1);
await page.evaluate((text) => {
  const dt = new DataTransfer(); dt.items.add(new File([text], 'bracket.dxf', { type: '' }));
  const c = window._app.canvas, r = c.getBoundingClientRect();
  c.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.left + 300, clientY: r.top + 300, bubbles: true, cancelable: true }));
}, inch);
await page.waitForFunction(() => window._app.activeSketch().entities.length > 0);
const ln = await page.evaluate(() => { const l = window._app.activeSketch().entities[0]; return Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y); });
check(Math.abs(ln - 50.8) < 1e-6 && /Converted from in to mm/.test(await page.evaluate(() => document.getElementById('app-notice')?.textContent || '')), `a .dxf dropped on the canvas: 2 in comes in as 50.8 mm (${ln})`);

// ---- Not a DXF ----
await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'notes.dxf')); window._app.canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
await page.waitForSelector('.app-dialog');
check(/not an ASCII DXF/.test(await page.textContent('.app-dialog')), 'a file that is not a DXF: says so');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

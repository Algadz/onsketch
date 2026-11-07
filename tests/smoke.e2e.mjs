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

if (shot) await page.screenshot({ path: shot });
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);

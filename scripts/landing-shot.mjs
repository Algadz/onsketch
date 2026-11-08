// Regenerates assets/app-preview.png for the landing page: builds a
// to-scale concept (a studio layout) with the core model, loads it into
// the editor in headless Chromium and takes a screenshot.
// Usage: node scripts/landing-shot.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Point, Line, Circle } from '../app/src/core/entities.js';
import { Project } from '../app/src/core/model.js';
import { Layer } from '../app/src/core/style.js';
import { HorizontalConstraint, VerticalConstraint, DistanceConstraint, RadiusConstraint } from '../app/src/core/constraints.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(new URL('..', import.meta.url).pathname);

/* ---- The concept: a 6 m × 4 m studio, in mm ---- */
const project = new Project();
project.name = 'Studio concept';
const sketch = project.addSketch('Sketch 1');
const room = project.layers[0]; room.name = 'Room';
const furniture = new Layer('Furniture'); project.layers.push(furniture);

function rect(layer, x, y, w, h, dims = []) {
  const a = new Point(x, y), b = new Point(x + w, y), c = new Point(x + w, y + h), d = new Point(x, y + h);
  const ls = [new Line(a, b), new Line(b, c), new Line(c, d), new Line(d, a)];
  for (const l of ls) { l.layerId = layer.id; sketch.addEntity(l); }
  const k = (C, ...args) => { const o = new C(...args); o.layerId = layer.id; sketch.constraints.push(o); return o; };
  k(HorizontalConstraint, ls[0].id, a.id, b.id); k(HorizontalConstraint, ls[2].id, c.id, d.id);
  k(VerticalConstraint, ls[1].id, b.id, c.id);   k(VerticalConstraint, ls[3].id, d.id, a.id);
  if (dims.includes('w')) k(DistanceConstraint, a.id, b.id, w);
  if (dims.includes('h')) k(DistanceConstraint, b.id, c.id, h);
  return { a, b, c, d };
}
function circle(layer, x, y, r, dim = false) {
  const c = new Circle(new Point(x, y), r); c.layerId = layer.id; sketch.addEntity(c);
  if (dim) { const k = new RadiusConstraint(c.id, r); k.isDiameter = true; k.layerId = layer.id; sketch.constraints.push(k); }
  return c;
}
const fill = (layer, color, x, y, opacity = 1) => sketch.fills.push({ id: 'f' + (sketch.fills.length + 1), layerId: layer.id, color, opacity, seed: { x, y } });

rect(room, 0, 0, 6000, 4000, ['w', 'h']);
fill(room, '#efe4d2', 300, 300);

rect(furniture, 3300, 600, 2200, 1700);            // rug
rect(furniture, 3500, 200, 1800, 300);             // sofa back… seat below
rect(furniture, 3500, 500, 1800, 600, ['w']);      // sofa
circle(furniture, 4400, 1750, 400, true);          // coffee table
rect(furniture, 200, 2000, 1600, 1900, ['w', 'h']);// bed
rect(furniture, 200, 2000, 1600, 400);             // pillows band
rect(furniture, 2600, 3300, 3200, 600, ['w']);     // kitchen counter
circle(furniture, 1300, 1050, 550, true);          // dining table
for (const [x, y] of [[1300, 310], [1300, 1790], [560, 1050], [2040, 1050]]) circle(furniture, x, y, 190);

fill(furniture, '#d9a066', 3400, 1700, 0.55);   // rug (outside table and sofa)
fill(furniture, '#47698f', 4400, 300);          // sofa back
fill(furniture, '#5b7fa6', 4400, 800);          // sofa
fill(furniture, '#8a5a3b', 4400, 1750);         // coffee table
fill(furniture, '#9cbfae', 1000, 3000);         // bed
fill(furniture, '#f4f1ea', 1000, 2200);         // pillows
fill(furniture, '#8b95a1', 4200, 3600);         // counter
fill(furniture, '#b77c4e', 1300, 1050);          // dining table
for (const [x, y] of [[1300, 310], [1300, 1790], [560, 1050], [2040, 1050]]) fill(furniture, '#c9a400', x, y);
project.activeLayerId = furniture.id;
const json = project.toJSON();

/* ---- Serve, load, shoot ---- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.route(/umami/, r => r.abort());
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light', showRelations: false })); } catch {} });
await page.goto(`http://localhost:${server.address().port}/app/`);
await page.waitForFunction(() => window._app);
await page.evaluate(async (json) => {
  const { Project } = await import('./src/core/model.js');
  const a = window._app;
  a.project = Project.fromJSON(json);
  a.selectionOrder = [];
  a.commit({ diagnostics: 'sync' });
  a.refreshUI();
  a.zoomFit();
}, json);
await page.waitForTimeout(600);
await page.screenshot({ path: join(root, 'assets/app-preview.png') });
await browser.close(); server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('wrote assets/app-preview.png');

// Regenerates the landing page images: builds sample to-scale concepts
// with the core model, loads each into the editor in headless Chromium and
// takes a screenshot.
//   assets/app-preview.png          the editor with its windows (hero)
//   assets/examples/<slug>.jpg      canvas only, one per example (carousel)
// Usage: node scripts/landing-shots.mjs
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Point, Line, Circle, Arc } from '../app/src/core/entities.js';
import { Project } from '../app/src/core/model.js';
import { Layer } from '../app/src/core/style.js';
import { HorizontalConstraint, VerticalConstraint, DistanceConstraint, RadiusConstraint } from '../app/src/core/constraints.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(new URL('..', import.meta.url).pathname);

/* ---- A tiny drawing kit over the model (all sizes in mm, y up) ---- */
function kit(name) {
  const project = new Project();
  project.name = name;
  const sketch = project.addSketch('Sketch 1');
  project.layers = [];
  const own = (o, layer) => { o.layerId = layer.id; return o; };
  const add = (e, layer, style) => { own(e, layer); if (style) e.style = style; sketch.addEntity(e); return e; };
  const con = (c, layer) => { sketch.constraints.push(own(c, layer)); return c; };
  const k = {
    project,
    layer(n) { const l = new Layer(n); project.layers.push(l); project.activeLayerId = l.id; return l; },
    /** Closed outline through pts; consecutive lines share their points. */
    poly(layer, pts, { style } = {}) {
      const ps = pts.map(([x, y]) => new Point(x, y));
      const lines = ps.map((p, i) => add(new Line(p, ps[(i + 1) % ps.length]), layer, style));
      return { ps, lines };
    },
    line(layer, x1, y1, x2, y2, style) { return add(new Line(new Point(x1, y1), new Point(x2, y2)), layer, style); },
    rect(layer, x, y, w, h, dims = '') {
      const { ps: [a, b, c, d], lines: ls } = k.poly(layer, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
      con(new HorizontalConstraint(ls[0].id, a.id, b.id), layer); con(new HorizontalConstraint(ls[2].id, c.id, d.id), layer);
      con(new VerticalConstraint(ls[1].id, b.id, c.id), layer);   con(new VerticalConstraint(ls[3].id, d.id, a.id), layer);
      if (dims.includes('w')) k.dim(layer, a, b, w);
      if (dims.includes('h')) k.dim(layer, b, c, h);
      return { a, b, c, d };
    },
    circle(layer, x, y, r, { dia = false, construction = false } = {}) {
      const c = add(new Circle(new Point(x, y), r), layer);
      c.construction = construction;
      if (dia) { const d = con(new RadiusConstraint(c.id, r), layer); d.isDiameter = true; }
      return c;
    },
    arc(layer, x, y, r, a0, a1, { radius = false } = {}) {
      const a = add(new Arc(new Point(x, y), r, a0, a1), layer);
      if (radius) con(new RadiusConstraint(a.id, r), layer);
      return a;
    },
    dim(layer, p1, p2, value) { return con(new DistanceConstraint(p1.id, p2.id, value ?? Math.hypot(p2.x - p1.x, p2.y - p1.y)), layer); },
    fill(layer, color, x, y, opacity = 1) {
      sketch.fills.push({ id: 'f' + (sketch.fills.length + 1), layerId: layer.id, color, opacity, seed: { x, y } });
    },
    pt: (x, y) => { const p = new Point(x, y); return p; },
  };
  return k;
}
const DASHED = { lineWidth: 1, lineStyle: 'dashed' };
const rand = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(7);

/* ---- The examples ---- */
const scenes = {};

scenes['floor-plan'] = () => {
  const k = kit('Studio layout');
  const room = k.layer('Room'), furn = k.layer('Furniture');
  k.rect(room, 0, 0, 6000, 4000, 'wh');
  k.fill(room, '#efe4d2', 300, 300);
  k.rect(furn, 3300, 600, 2200, 1700);             // rug
  k.rect(furn, 3500, 200, 1800, 300);              // sofa back
  k.rect(furn, 3500, 500, 1800, 600, 'w');         // sofa
  k.circle(furn, 4400, 1750, 400, { dia: true });  // coffee table
  k.rect(furn, 200, 2000, 1600, 1900, 'wh');       // bed
  k.rect(furn, 200, 2000, 1600, 400);              // pillows
  k.rect(furn, 2600, 3300, 3200, 600, 'w');        // kitchen counter
  k.circle(furn, 1300, 1050, 550, { dia: true });  // dining table
  const chairs = [[1300, 310], [1300, 1790], [560, 1050], [2040, 1050]];
  for (const [x, y] of chairs) k.circle(furn, x, y, 190);
  k.fill(furn, '#d9a066', 3400, 1700, 0.55);
  k.fill(furn, '#47698f', 4400, 300);
  k.fill(furn, '#5b7fa6', 4400, 800);
  k.fill(furn, '#8a5a3b', 4400, 1750);
  k.fill(furn, '#9cbfae', 1000, 3000);
  k.fill(furn, '#f4f1ea', 1000, 2200);
  k.fill(furn, '#8b95a1', 4200, 3600);
  k.fill(furn, '#b77c4e', 1300, 1050);
  for (const [x, y] of chairs) k.fill(furn, '#c9a400', x, y);
  return k.project;
};

scenes.pcb = () => {
  const k = kit('Sensor board');
  const board = k.layer('Board'), cu = k.layer('Copper'), parts = k.layer('Parts');
  const B = k.rect(board, 0, 0, 100, 64, 'wh');
  const holes = [[4, 4], [96, 4], [4, 60], [96, 60]];
  holes.forEach(([x, y], i) => k.circle(board, x, y, 1.6, { dia: i === 3 }));
  k.fill(board, '#1d6b47', 50, 10);
  void B;
  // U1: a 12-pin chip, pads on copper, body on parts
  const ux = 45, pitch = 2.54;
  for (let i = 0; i < 6; i++) {
    const x = ux + (i - 2.5) * pitch - 0.7;
    k.rect(cu, x, 39.6, 1.4, 2.6); k.fill(cu, '#d4a017', x + 0.7, 40.9);
    k.rect(cu, x, 25.8, 1.4, 2.6); k.fill(cu, '#d4a017', x + 0.7, 27.1);
  }
  k.rect(parts, 37, 29, 16, 10); k.fill(parts, '#22262b', 45, 34);
  // J1: 6-pin header on the right, with pitch dimension
  const hx = 88, pads = [];
  for (let i = 0; i < 6; i++) { const y = 20 + i * pitch; pads.push(k.circle(cu, hx, y, 0.95)); k.fill(cu, '#d4a017', hx, y); }
  k.dim(cu, pads[0].center, pads[1].center, pitch);
  // traces: from the top pads up and right to the header (butted segments)
  for (let i = 0; i < 4; i++) {
    const x = ux + (i + 2 - 2.5) * pitch - 0.45, top = 46 + i * 2.2, y = 20 + (5 - i) * pitch;
    k.rect(cu, x, 42.2, 0.9, top - 42.2); k.fill(cu, '#c98a3a', x + 0.45, (42.2 + top) / 2);
    k.rect(cu, x, top, 74 + i * 2.2 - x, 0.9); k.fill(cu, '#c98a3a', (x + 74) / 2, top + 0.45);
    const vx = 74 + i * 2.2;
    k.rect(cu, vx, y + 0.45, 0.9, top - y - 0.45); k.fill(cu, '#c98a3a', vx + 0.45, (y + top) / 2);
    k.rect(cu, vx + 0.9, y - 0.45, hx - 0.95 - vx - 0.9, 0.9); k.fill(cu, '#c98a3a', (vx + hx) / 2, y);
  }
  // decoupling caps C1–C3 and a crystal
  for (let i = 0; i < 3; i++) {
    const x = 26 + i * 6;
    k.rect(cu, x, 14, 1.6, 1.4); k.fill(cu, '#d4a017', x + 0.8, 14.7);
    k.rect(cu, x, 18, 1.6, 1.4); k.fill(cu, '#d4a017', x + 0.8, 18.7);
    k.rect(parts, x - 0.2, 15.6, 2, 2.2); k.fill(parts, '#b28a5a', x + 0.8, 16.7);
  }
  k.rect(parts, 58, 12, 11, 5); k.fill(parts, '#b8bec6', 63.5, 14.5);
  // USB connector on the left edge, electrolytic cap
  k.rect(parts, -1.5, 26, 9, 12); k.fill(parts, '#b8bec6', 3, 32);
  k.circle(parts, 20, 48, 4); k.fill(parts, '#2b2f36', 20, 50.5);
  k.circle(parts, 20, 48, 1.2); k.fill(parts, '#8b95a1', 20, 48);
  return k.project;
};

scenes.engineering = () => {
  const k = kit('Flange and link');
  const fl = k.layer('Flange'), ln = k.layer('Link');
  k.circle(fl, 0, 0, 60, { dia: true });
  k.circle(fl, 0, 0, 20, { dia: true });
  k.circle(fl, 0, 0, 45, { dia: true, construction: true });
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; k.circle(fl, 45 * Math.cos(a), 45 * Math.sin(a), 5, { dia: i === 0 }); }
  k.rect(fl, -6, 16, 12, 9, 'w');                 // keyway
  k.fill(fl, '#9aa6b2', 0, -32);
  // link arm: two bosses joined by tangent lines
  const x1 = 110, x2 = 210, r = 18;
  k.arc(ln, x1, 0, r, Math.PI / 2, 3 * Math.PI / 2, { radius: true });
  k.arc(ln, x2, 0, r, -Math.PI / 2, Math.PI / 2);
  k.line(ln, x1, r, x2, r); k.line(ln, x1, -r, x2, -r);
  const h1 = k.circle(ln, x1, 0, 7, { dia: true }), h2 = k.circle(ln, x2, 0, 7);
  k.dim(ln, h1.center, h2.center, x2 - x1);
  k.rect(ln, x1 + 25, -6, 50, 12);                // lightening slot
  k.fill(ln, '#5f7f9f', x1 + 15, 10);
  return k.project;
};

scenes.diy = () => {
  const k = kit('Bookshelf');
  const back = k.layer('Back panel'), body = k.layer('Carcass'), items = k.layer('Items');
  const W = 900, H = 1800, t = 18;
  k.rect(back, t, 80, W - 2 * t, H - 80 - t); k.fill(back, '#efe4d2', W / 2, 300);
  k.rect(body, 0, 0, t, H, 'h'); k.rect(body, W - t, 0, t, H);
  k.rect(body, t, H - t, W - 2 * t, t);
  const plinth = k.rect(body, t, 0, W - 2 * t, 80);
  const shelves = [440, 840, 1240];
  const sh = shelves.map(y => k.rect(body, t, y, W - 2 * t, t));
  const bottom = k.rect(body, 0, -40, W, 40, 'w'); void bottom;
  for (const p of [[t / 2, 900], [W - t / 2, 900], [W / 2, H - t / 2], [W / 2, 40], ...shelves.map(y => [W / 2, y + t / 2])]) k.fill(body, '#c8955f', p[0], p[1]);
  k.fill(body, '#a8743f', W / 2, -20);
  k.dim(body, sh[0].d, sh[1].a, 840 - 440 - t);
  void plinth;
  // books on the three lower shelves and the plinth top
  const colors = ['#5b7fa6', '#d63a3a', '#14946b', '#c9a400', '#8a4fd1', '#e07b00', '#47698f', '#9cbfae'];
  for (const base of [80, 440 + t, 840 + t]) {
    let x = t + 30;
    while (x < W - t - 160) {
      const w = 22 + Math.round(rand() * 26), h = 220 + Math.round(rand() * 110);
      k.rect(items, x, base, w, h); k.fill(items, colors[Math.floor(rand() * colors.length)], x + w / 2, base + h / 2);
      x += w + (rand() < 0.15 ? 40 : 2);
    }
  }
  // top shelf: a box and a plant
  k.rect(items, 80, 1240 + t, 260, 180); k.fill(items, '#d9a066', 210, 1240 + t + 90);
  k.rect(items, 560, 1240 + t, 140, 160); k.fill(items, '#b77c4e', 630, 1240 + t + 80);
  k.circle(items, 630, 1240 + t + 300, 130); k.fill(items, '#6aa121', 630, 1240 + t + 320);
  return k.project;
};

/** Panel outline with box fingers: n segments per edge, odd ones notched by t. */
function fingers(x0, y0, w, h, nw, nh, t) {
  const pts = [];
  const edge = (ax, ay, dx, dy, nx, ny, L, n) => {
    for (let i = 0; i < n; i++) {
      const o = i % 2 ? t : 0;
      pts.push([ax + dx * L * i / n + nx * o, ay + dy * L * i / n + ny * o]);
      pts.push([ax + dx * L * (i + 1) / n + nx * o, ay + dy * L * (i + 1) / n + ny * o]);
    }
  };
  edge(x0, y0, 1, 0, 0, 1, w, nw);
  edge(x0 + w, y0, 0, 1, -1, 0, h, nh);
  edge(x0 + w, y0 + h, -1, 0, 0, -1, w, nw);
  edge(x0, y0 + h, 0, -1, 1, 0, h, nh);
  return pts.filter((p, i) => { const q = pts[(i + 1) % pts.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9; });
}

scenes['laser-cut'] = () => {
  const k = kit('Laser-cut box');
  const cut = k.layer('Cut'), eng = k.layer('Engrave');
  const t = 3, ply = '#e3c18f';
  const front = k.poly(cut, fingers(0, 0, 120, 80, 7, 5, t));
  k.fill(cut, ply, 60, 40);
  const side = k.poly(cut, fingers(135, 0, 80, 80, 5, 5, t));
  k.fill(cut, ply, 175, 40);
  k.poly(cut, fingers(230, 0, 120, 80, 7, 5, t));
  k.circle(cut, 290, 62, 9, { dia: true });          // finger hole in the lid
  k.fill(cut, ply, 255, 20);
  // dimensions: panel width and height, material thickness
  const p = (poly, x, y) => poly.ps.find(q => Math.abs(q.x - x) < 1e-6 && Math.abs(q.y - y) < 1e-6);
  k.dim(cut, p(front, 0, 0), p(front, 120, 0), 120);
  k.dim(cut, p(side, 215, 0), p(side, 215, 80), 80);
  k.dim(cut, p(front, 120 / 7, 0), p(front, 120 / 7, t), t);
  // engraving: a star on the front and a leaf on the side
  const star = [];
  for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 9 : 22; star.push([60 + r * Math.cos(a), 40 + r * Math.sin(a)]); }
  k.poly(eng, star); k.fill(eng, '#7a4b2a', 60, 40);
  k.poly(eng, [[175, 18], [195, 40], [175, 62], [155, 40]]); k.fill(eng, '#7a4b2a', 175, 40, 0.8);
  k.rect(eng, 255, 18, 70, 10); k.fill(eng, '#7a4b2a', 290, 23, 0.8);
  return k.project;
};

scenes.garden = () => {
  const k = kit('Garden plan');
  const ground = k.layer('Ground'), hard = k.layer('Hardscape'), plant = k.layer('Planting');
  k.rect(ground, 0, 0, 12000, 8000, 'wh'); k.fill(ground, '#9cc47a', 6000, 3000);
  k.rect(hard, 0, 5200, 4500, 2800, 'w'); k.fill(hard, '#cfc8bb', 2250, 6600);           // patio
  for (let i = 0; i < 6; i++) { const x = 4900 + i * 700, y = 5600 - i * 520; k.circle(hard, x, y, 260); k.fill(hard, '#b9b2a5', x, y); }
  k.rect(hard, 9200, 300, 2500, 1900, 'w'); k.fill(hard, '#9b7653', 10450, 1250);        // shed
  k.circle(hard, 2600, 2300, 1100, { dia: true }); k.fill(hard, '#6aa7d8', 2600, 2300);  // pond
  for (let i = 0; i < 3; i++) { const x = 6200 + i * 1600; k.rect(plant, x, 6000, 1200, 1600, i === 0 ? 'wh' : ''); k.fill(plant, '#7a4b2a', x + 600, 6800); }
  for (const [x, y, r] of [[900, 1000, 800], [5600, 1700, 1300], [11300, 7300, 600], [11000, 4300, 700]]) { k.circle(plant, x, y, r); k.fill(plant, '#3f7d3a', x, y, 0.9); }
  return k.project;
};

scenes.packaging = () => {
  const k = kit('Tuck box dieline');
  const die = k.layer('Dieline'), art = k.layer('Artwork');
  k.poly(die, [
    [0, 5], [0, 95], [15, 100], [75, 100], [77, 122], [103, 122], [105, 100], [105, 130], [108, 130], [110, 145],
    [160, 145], [162, 130], [165, 130], [165, 100], [167, 122], [193, 122], [195, 100], [195, 0], [193, -22],
    [167, -22], [165, 0], [105, 0], [103, -22], [77, -22], [75, 0], [75, -30], [72, -30], [70, -45], [20, -45],
    [18, -30], [15, -30], [15, 0],
  ]);
  for (const x of [15, 75, 105, 165]) k.line(die, x, 0, x, 100, DASHED);
  k.line(die, 105, 100, 165, 100, DASHED); k.line(die, 108, 130, 162, 130, DASHED);
  k.line(die, 15, 0, 75, 0, DASHED); k.line(die, 18, -30, 72, -30, DASHED);
  for (const [a, b] of [[75, 105], [165, 195]]) { k.line(die, a, 100, b, 100, DASHED); k.line(die, a, 0, b, 0, DASHED); }
  const main = '#0f9fb5', side = '#f2b33d', flap = '#f6e7c8';
  k.fill(die, '#ddd6c6', 7, 50);
  k.fill(die, main, 45, 50); k.fill(die, main, 135, 50); k.fill(die, main, 135, 115); k.fill(die, main, 45, -15);
  k.fill(die, side, 90, 50); k.fill(die, side, 180, 50);
  for (const p of [[90, 110], [180, 110], [90, -10], [180, -10], [135, 138], [45, -38]]) k.fill(die, flap, p[0], p[1]);
  // dimensions on the outline points
  const pts = k.project.active().entities.filter(e => e.layerId === die.id).flatMap(e => [e.p1, e.p2]);
  const at = (x, y) => pts.find(q => Math.abs(q.x - x) < 1e-6 && Math.abs(q.y - y) < 1e-6);
  k.dim(die, at(15, 100), at(75, 100), 60);
  k.dim(die, at(165, 100), at(195, 100), 30);
  k.dim(die, at(195, 0), at(195, 100), 100);
  // front artwork: label and logo
  k.rect(art, 25, 30, 40, 40); k.fill(art, '#ffffff', 45, 35, 0.9);
  k.circle(art, 45, 55, 9); k.fill(art, '#d63a3a', 45, 55);
  return k.project;
};

scenes.booth = () => {
  const k = kit('Trade-show booth');
  const floor = k.layer('Floor'), fx = k.layer('Fixtures');
  k.rect(floor, 0, 0, 6000, 3000, 'wh'); k.fill(floor, '#3d4f66', 300, 1500);
  k.rect(fx, 0, 2900, 6000, 100); k.fill(fx, '#f4f1ea', 3000, 2950);              // back wall
  k.rect(fx, 2100, 2820, 1800, 80, 'w'); k.fill(fx, '#111418', 3000, 2860);       // screen
  k.rect(fx, 100, 1300, 400, 1500); k.fill(fx, '#c8955f', 300, 2000);             // shelving
  for (let i = 0; i < 4; i++) { k.rect(fx, 120, 1350 + i * 360, 360, 120); k.fill(fx, ['#d63a3a', '#f2b33d', '#0f9fb5', '#ffffff'][i], 300, 1410 + i * 360); }
  // curved reception counter
  const cx = 3000, cy = 900;
  k.arc(fx, cx, cy, 900, Math.PI, 2 * Math.PI, { radius: true });
  k.arc(fx, cx, cy, 500, Math.PI, 2 * Math.PI);
  k.line(fx, cx - 900, cy, cx - 500, cy); k.line(fx, cx + 500, cy, cx + 900, cy);
  k.fill(fx, '#f2b33d', cx, cy - 700);
  // meeting corner
  k.circle(fx, 4900, 1700, 450, { dia: true }); k.fill(fx, '#f4f1ea', 4900, 1700);
  for (const a of [0.5, 2.6, 4.7]) { const x = 4900 + 700 * Math.cos(a), y = 1700 + 700 * Math.sin(a); k.circle(fx, x, y, 200); k.fill(fx, '#0f9fb5', x, y); }
  for (const [x, y] of [[300, 300], [5700, 300], [5700, 2600]]) { k.circle(fx, x, y, 220); k.fill(fx, '#6aa121', x, y); }
  return k.project;
};

/* ---- Serve, load, shoot ---- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
await mkdir(join(root, 'assets/examples'), { recursive: true });
const browser = await chromium.launch();
const errors = [];

async function shoot(project, { viewport, out, canvasOnly, quality }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.route(/umami/, r => r.abort());
  page.on('pageerror', e => errors.push(`${out}: ${e}`));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light', showRelations: false })); } catch {} });
  await page.goto(`http://localhost:${server.address().port}/app/`);
  await page.waitForFunction(() => window._app);
  if (canvasOnly) await page.addStyleTag({ content: '.fwin { display: none !important; }' });
  await page.evaluate(async (json) => {
    const { Project } = await import('./src/core/model.js');
    const a = window._app;
    a.project = Project.fromJSON(json);
    a.selectionOrder = [];
    a.commit({ diagnostics: 'sync' });
    a.refreshUI();
    a.zoomFit();
  }, project.toJSON());
  await page.waitForTimeout(500);
  const target = canvasOnly ? page.locator('#canvas') : page;
  await target.screenshot({ path: join(root, out), ...(quality ? { type: 'jpeg', quality } : {}) });
  await page.close();
  console.log('wrote', out);
}

const only = process.argv[2];
if (!only || only === 'hero') await shoot(scenes['floor-plan'](), { viewport: { width: 1440, height: 900 }, out: 'assets/app-preview.png' });
for (const slug of Object.keys(scenes)) {
  if (only && only !== slug) continue;
  await shoot(scenes[slug](), { viewport: { width: 1280, height: 860 }, out: `assets/examples/${slug}.jpg`, canvasOnly: true, quality: 82 });
}
await browser.close(); server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

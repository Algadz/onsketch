// Sketches built from AI specs (app/src/core/spec.js, what the MCP server
// saves) open in the editor as drawn: same shapes and relations, nothing
// over-defined (red), nothing moved by the editor's own solve.
// Usage: node tests/mcp.e2e.mjs   (SHOT_DIR=… to keep screenshots)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildFromSpec } from '../app/src/core/spec.js';
import { FORMAT } from '../supabase/functions/mcp/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}/app/`;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

const SPECS = {
  'format guide example': JSON.parse(FORMAT.slice(FORMAT.indexOf('{', FORMAT.indexOf('Example (')))),
  'bracket with holes': {
    shapes: [
      { id: 'plate', type: 'rectangle', corner: [0, 0], width: 80, height: 40 },
      { id: 'h1', type: 'circle', center: [15, 20], d: 8 },
      { id: 'h2', type: 'circle', center: [65, 20], d: 8 },
      { id: 'cl', type: 'line', from: [40, -5], to: [40, 45], construction: true },
    ],
    constraints: [
      { type: 'fix', point: 'plate.bl' },
      { type: 'length', line: 'plate.bottom', value: 80 }, { type: 'length', line: 'plate.left', value: 40 },
      { type: 'diameter', shape: 'h1', value: 8 }, { type: 'equal', a: 'h1', b: 'h2' },
      { type: 'symmetric', a: 'h1.center', b: 'h2.center', axis: 'cl' },
      { type: 'distance', a: 'plate.bl', b: 'h1.center', axis: 'x', value: 15 },
      { type: 'distance', a: 'plate.bl', b: 'h1.center', axis: 'y', value: 20 },
    ],
  },
  'L-shape polyline with an angle': {
    shapes: [
      { id: 'L', type: 'polyline', closed: true, points: [[0, 0], [50, 0], [50, 10], [10, 10], [10, 40], [0, 40]] },
      { id: 'brace', type: 'line', from: [10, 25], to: [25, 10] },
    ],
    constraints: [
      { type: 'on', point: 'brace.start', shape: 'L.s4' }, { type: 'on', point: 'brace.end', shape: 'L.s3' },
      { type: 'angle', a: 'L.s3', b: 'brace', value: 135 },
    ],
  },
  'arcs meeting arcs': {
    shapes: [
      { id: 'a1', type: 'arc', center: [0, 0], r: 10, start_angle: 0, end_angle: 90 },
      { id: 'a2', type: 'arc', center: [0, 20], r: 10, start_angle: 270, end_angle: 180, clockwise: true },
      { id: 'c', type: 'circle', center: [30, 0], r: 6 },
    ],
    constraints: [{ type: 'tangent', a: 'a1', b: 'c' }],
  },
};

const browser = await chromium.launch();
for (const [name, spec] of Object.entries(SPECS)) {
  const { project, report } = buildFromSpec(spec, { title: name });
  const json = project.toJSON();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await ctx.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
  await ctx.addInitScript((j) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sketchcad:last', j); localStorage.setItem('onsketch:tour-done', '1'); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(json));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base);
  await page.waitForFunction(() => window._app?.project);
  const got = await page.evaluate(() => {
    const app = window._app;
    app.solveAndRender?.();
    const s = app.project.active();
    const pts = [];
    const walk = (e) => { if (e.constructor.kind === 'point' && !e.arcOwner) pts.push([e.id, e.x, e.y]); for (const c of e.children()) walk(c); };
    s.entities.forEach(walk);
    const arcs = s.entities.filter(e => e.constructor.kind === 'arc').map(a => [a.center.x, a.center.y, a.r, a.a0, a.a1]);
    return { arcs, name: app.project.name, entities: s.entities.length, constraints: s.constraints.length, state: app._lastSolve?.state, redundant: app._lastSolve?.redundantIds?.size ?? 0, pts };
  });
  const want = project.active();
  check(got.name === name && got.entities === want.entities.length && got.constraints === want.constraints.length,
    `${name}: opens with its ${want.entities.length} shapes and ${want.constraints.length} relations`);
  check(got.state !== 'over' && got.redundant === 0, `${name}: nothing over-defined in the editor (state ${got.state}; spec said ${report.state})`);
  if (report.state === 'fully') check(got.state === 'fully', `${name}: fully defined in the editor too`);
  const before = new Map();
  // Arc ends are derived (not saved) and get new ids on load: compared through their arcs' parameters instead.
  const walk = (e) => { if (e.constructor.kind === 'point' && !e.arcOwner) before.set(e.id, [e.x, e.y]); for (const c of e.children()) walk(c); };
  want.entities.forEach(walk);
  const moved = Math.max(0, ...got.pts.map(([id, x, y]) => { const b = before.get(id); return b ? Math.hypot(b[0] - x, b[1] - y) : 0; }));
  check(moved < 1e-6, `${name}: the editor's solve moves nothing (max ${moved.toExponential(1)})`);
  const arcsBefore = want.entities.filter(e => e.constructor.kind === 'arc').map(a => [a.center.x, a.center.y, a.r, a.a0, a.a1]);
  const arcDiff = Math.max(0, ...arcsBefore.flatMap((a, i) => a.map((v, k) => Math.abs(v - (got.arcs[i]?.[k] ?? Infinity)))));
  if (arcsBefore.length) check(arcDiff < 1e-6, `${name}: arcs unchanged too (max ${arcDiff.toExponential(1)})`);
  check(errors.length === 0, `${name}: no page errors` + (errors.length ? `: ${errors.join(' | ')}` : ''));
  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, name.replace(/\W+/g, '-') + '.png') });
  await ctx.close();
}
await browser.close();
server.close();
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall MCP sketch checks passed');

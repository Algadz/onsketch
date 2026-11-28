// Sketches built from AI specs (app/src/core/spec.js, what the MCP server
// saves) open in the editor as drawn: same shapes and relations, nothing
// over-defined (red), nothing moved by the editor's own solve.
// Usage: node tests/mcp.e2e.mjs   (SHOT_DIR=… to keep screenshots)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildFromSpec, attachSpec } from '../app/src/core/spec.js';
import { FORMAT } from '../supabase/functions/mcp/server.js';
import { pngDataUrl } from './unit/helpers.js';

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
  'bar mechanism': {
    variables: { a: { value: 60, slider: { min: 0, max: 360, step: 5 } } },
    layers: ['Frame', 'Links', 'Motion', 'Notes'],
    points: { o: [0, 0] },
    shapes: [
      { id: 'ground', type: 'line', from: [-20, 0], to: [70, 0], construction: true, layer: 'Frame' },
      { id: 'crank', type: 'bar', from: 'o', to: [5, 8.660254], width: 6, hole: 2, layer: 'Links' },
      { id: 'rod', type: 'bar', from: 'crank.end', to: [28.452079, 0], width: 5, hole: 2, layer: 'Links' },
    ],
    constraints: [
      { type: 'fix', point: 'o' }, { type: 'fix', point: 'ground.start' }, { type: 'fix', point: 'ground.end' },
      { id: 'r', type: 'length', line: 'crank.axis', value: 10 }, { type: 'length', line: 'rod.axis', value: 25 },
      { type: 'on', point: 'rod.end', shape: 'ground' },
      { type: 'angle', a: 'ground', b: 'crank.axis', value: 'a', signed: true },
    ],
    fills: [{ at: [-2, 0], color: '#9bc3ff' }],
    drawing: [
      { id: 'circle', type: 'trace', point: 'crank.end', sweep: { variable: 'a', from: 0, to: 360, steps: 72 }, color: '#1f7ad6', layer: 'Motion' },
      { id: 'slide', type: 'trace', point: 'rod.end', sweep: { variable: 'a', from: 0, to: 180 }, color: '#d63a3a', layer: 'Motion' },
      { id: 'turn', type: 'arrow', from: [-14, 2], to: [-2, 14], bend: 0.35, color: '#14946b', layer: 'Notes' },
      { id: 'tag', type: 'text', text: 'crank', at: [2.5, 14], size: 2.5, link: 'crank', layer: 'Notes' },
      { id: 'glow', type: 'shape', shape: 'ellipse', center: [28.452079, 0], width: 12, height: 12, fill: 'tint', outline: 'none', color: '#c9a400', link: 'rod', layer: 'Notes' },
    ],
  },
  'every feature': {
    variables: { W: { value: 120, slider: { min: 80, max: 200, step: 5 } }, H: 'W / 2', N: 4 },
    display: { names: true },
    layers: ['Part', 'Motion', 'Notes'],
    points: { o: [150, 10] },
    shapes: [
      { id: 'axis', type: 'line', from: [60, -10], to: [60, 70], construction: true, line_style: 'center', layer: 'Part' },
      { id: 'half', type: 'polyline', points: [[60, 0], [120, 0], [120, 60], [60, 60]], layer: 'Part' },
      { id: 'm', type: 'mirror', of: ['half'], axis: 'axis' },
      { id: 'hole', type: 'circle', center: [15, 30], r: 4, layer: 'Part' },
      { id: 'holes', type: 'pattern', kind: 'linear', of: ['hole'], count: 'N', spacing: 'W / 4' },
      { id: 'nut', type: 'polygon', center: [60, 30], sides: 6, r: 8, layer: 'Part' },
      { id: 'blob', type: 'curve', points: [[20, 45], [40, 52], [30, 56]], closed: true, layer: 'Part' },
      { id: 'crank', type: 'line', from: 'o', to: [155, 18.660254], layer: 'Motion' },
      { id: 'rod', type: 'line', from: 'crank.end', to: [178.452079, 10], layer: 'Motion' },
      { id: 'rail', type: 'line', from: [130, 10], to: [200, 10], construction: true, layer: 'Motion' },
    ],
    constraints: [
      { type: 'fix', point: 'half.p1' },
      { type: 'length', line: 'half.s1', value: 'W / 2', name: 'halfW' },
      { type: 'length', line: 'half.s2', value: 'H' },
      { type: 'vertical', line: 'axis' },
      { type: 'radius', shape: 'hole', value: 4 },
      { type: 'radius', shape: 'nut.circle', value: 8 },
      { type: 'distance', a: 'half.p1', b: 'hole.center', reference: true },
      { type: 'fix', point: 'o' }, { type: 'length', line: 'crank', value: 10 }, { type: 'length', line: 'rod', value: 25 },
      { type: 'on', point: 'rod.end', shape: 'rail' }, { type: 'fix', point: 'rail.start' }, { type: 'fix', point: 'rail.end' },
    ],
    fills: [{ at: [100, 50], color: '#cfe3ff', layer: 'Part' }],
    drawing: [
      { type: 'trace', point: 'crank.end', color: '#1f7ad6', layer: 'Motion' },
      { type: 'trace', point: 'rod.end', color: '#d63a3a', layer: 'Motion' },
      { type: 'text', text: 'Width {W} mm', at: [60, 75], size: 5, bold: true, box: true, layer: 'Notes', link: 'half.s3' },
      { type: 'image', src: pngDataUrl(40, 20), center: [160, 50], width: 30, layer: 'Notes' },
      { type: 'arrow', from: [150, 40], to: { on: 'crank', t: 1 }, layer: 'Notes' },
    ],
  },
  'annotated part': {
    layers: ['Part', 'Notes'], background: '#f7f3ea',
    shapes: [
      { id: 'plate', type: 'rectangle', corner: [0, 0], width: 80, height: 40, layer: 'Part' },
      { id: 'hole', type: 'circle', center: [20, 20], d: 10, layer: 'Part' },
      { id: 'slot', type: 'rectangle', corner: [50, 15], width: 20, height: 10, layer: 'Part' },
      { id: 'axis', type: 'line', from: [40, -5], to: [40, 45], construction: true, line_style: 'center', layer: 'Part' },
    ],
    fills: [{ at: [40, 35], color: '#cfe3ff', layer: 'Part' }, { at: [60, 20], color: '#ffe08a', opacity: 0.6, layer: 'Part' }],
    drawing: [
      { type: 'text', text: 'Ø10 through', at: [20, 52], size: 4, box: true, link: 'hole', layer: 'Notes' },
      { type: 'arrow', from: [20, 49], to: { on: 'hole', angle: 90 }, color: '#d63a3a', layer: 'Notes' },
      { type: 'shape', shape: 'ellipse', center: 'hole.center', width: 16, height: 16, color: '#d63a3a', dash: true, link: 'hole', layer: 'Notes' },
      { type: 'shape', shape: 'callout', center: [92, 40], width: 26, height: 14, fill: 'paper', layer: 'Notes', group: 'note' },
      { type: 'text', text: 'Deburr\nall edges', at: [92, 41], size: 3, layer: 'Notes', group: 'note' },
      { type: 'arrow', from: [80, 33], to: { on: 'slot.right', t: 0.5 }, layer: 'Notes' },
      { type: 'marker', points: [[0, -4], [80, -4]], color: '#c9a400', opacity: 0.5, link: 'plate.bottom', layer: 'Notes' },
      { type: 'text', text: 'BRACKET  80 × 40', at: [0, -10], align: 'left', size: 4, bold: true, link: { to: 'plate.bottom', t: 0 }, layer: 'Notes' },
    ],
  },
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
  attachSpec(project, spec);                       // as the MCP server saves it
  const json = project.toJSON();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await ctx.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
  await ctx.addInitScript((j) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sketchcad:last', j); localStorage.setItem('onsketch:tour-done', '1'); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(json));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base);
  await page.waitForFunction(() => window._app?.project);
  const got = await page.evaluate(async () => {
    const app = window._app;
    app.solveAndRender?.();
    const s = app.project.active();
    const pts = [];
    const walk = (e) => { if (e.constructor.kind === 'point' && !e.arcOwner) pts.push([e.id, e.x, e.y]); for (const c of e.children()) walk(c); };
    s.entities.forEach(walk);
    const arcs = s.entities.filter(e => e.constructor.kind === 'arc').map(a => [a.center.x, a.center.y, a.r, a.a0, a.a1]);
    const stale = s.strokes.filter(k => k.traces && (k._stale || app._pathIsStale?.(k))).length;
    const { specFingerprint } = await import('./src/core/spec.js');
    const exact = !!app.project.aiSpec && specFingerprint(app.project) === app.project.aiSpec.fp;
    const eqErrors = (app.project.variables || []).filter(v => v.error).length + s.constraints.filter(c => c.exprError).length;
    return { exact, stale, eqErrors, sliders: (app.project.variables || []).filter(v => v.slider).length, strokes: s.strokes.map(k => k.kind), fills: s.fills.length, arcs, name: app.project.name, entities: s.entities.length, constraints: s.constraints.length, state: app._lastSolve?.state, redundant: app._lastSolve?.redundantIds?.size ?? 0, pts };
  });
  const want = project.active();
  check(got.name === name && got.entities === want.entities.length && got.constraints === want.constraints.length,
    `${name}: opens with its ${want.entities.length} shapes and ${want.constraints.length} relations`);
  check(JSON.stringify(got.strokes) === JSON.stringify(want.strokes.map(k => k.kind)) && got.fills === want.fills.length,
    `${name}: drawing side intact (${got.strokes.length} items, ${got.fills} fills)`);
  check(got.exact, `${name}: still reads back exactly as sent after the editor opened it`);
  if (name === 'every feature') {
    check(got.stale === 0, 'every feature: traced paths up to date in the editor');
    check(got.eqErrors === 0, 'every feature: no equation errors in the editor');
    check(got.sliders === 1, 'every feature: the slider is there');
  }
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
  if (name === 'format guide example') {
    // Change the hole's position in the editor, as a person would: the
    // linked label and the attached arrow follow, the fill stays.
    const after = await page.evaluate(async () => {
      const app = window._app, s = app.project.active();
      const c = s.constraints.find(k => k.kind === 'distance' && k.axis === 'x' && k.value === 15);
      const label = s.strokes[0], arrow = s.strokes[1];
      const mid = (t) => { const b = t.points[0]; return b.x; };
      const before = { labelX: mid(label), tipX: arrow.points[1].x };
      app.setDimensionFromText(c, '35');
      await new Promise(r => setTimeout(r, 300));
      const hole = s.entities.find(e => e.constructor.kind === 'circle');
      return { before, labelX: mid(label), tip: arrow.points[1], hole: [hole.center.x, hole.center.y, hole.r], fills: s.fills.length, regions: s.fills.filter(f => f.region).length };
    });
    check(Math.abs(after.hole[0] - 35) < 1e-6, 'editor: the hole moved to x = 35');
    check(Math.abs(after.labelX - after.before.labelX - 20) < 1e-6, 'editor: the label linked to the hole moved with it');
    check(Math.abs(after.tip.x - 35) < 1e-6 && Math.abs(after.tip.y - (after.hole[1] + after.hole[2])) < 1e-6, 'editor: the arrow tip stays on top of the hole');
    check(after.fills === 1 && after.regions === 1, 'editor: the fill still colours the plate');
    if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'format-example-after-edit.png') });
  }
  await ctx.close();
}
await browser.close();
server.close();
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall MCP sketch checks passed');

// Fill colours must depend on the geometry only, not on the solver's
// rounding noise. Two root causes used to make colours jump while a
// variable was scrubbed (tests/fixtures/hex-pitch.json):
//  1. nearly coincident edges (shared edges, ends equal to ~1e-9) were
//     treated as crossing lines, so a shared edge split at a meaningless
//     point and areas merged or grew slivers from one frame to the next;
//  2. colour matching let a former island that sits in one of an area's
//     holes stand in for the area itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Point, Line } from '../../app/src/core/entities.js';
import { allRegions, findFaceAt, reconcileRegions, referenceRegions, regionContains } from '../../app/src/core/regions.js';
import { Project } from '../../app/src/core/model.js';
import { Solver } from '../../app/src/core/solver.js';
import { internalValue, solveEquations, ensureDimensionNames } from '../../app/src/core/equations.js';

let nid = 0; const mk = () => 'n' + (nid++);
const square = (x, y, s) => {
  const p = [new Point(x, y), new Point(x + s, y), new Point(x + s, y + s), new Point(x, y + s)];
  return [0, 1, 2, 3].map(i => new Line(p[i], p[(i + 1) % 4]));
};
const paint = (ents, pt, color) => ({ id: color, layerId: 'L', color, opacity: 1, seed: pt, region: findFaceAt(ents, pt) });
const colourAt = (fills, pt) => fills.find(f => f.region && regionContains(f.region, pt))?.color ?? null;
const rand = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)(11);

test('a shared edge with solver noise always gives two areas', () => {
  // Two regular hexagons sharing a diagonal edge, each drawing its own
  // line there. Jitter one copy by 1e-9..1e-8 (solver noise, a tiny tilt):
  // it must stay one shared edge, never a crossing, a sliver or a merge.
  // (Before the fix: 8 wrong area counts in these 500 tries.)
  const hex = (cx, cy, r) => {
    const p = [...Array(6)].map((_, i) => new Point(cx + r * Math.cos(Math.PI / 6 + i * Math.PI / 3), cy + r * Math.sin(Math.PI / 6 + i * Math.PI / 3)));
    return p.map((q, i) => new Line(q, p[(i + 1) % 6]));
  };
  const r = 3.5333836473645466, d = r * Math.sqrt(3);
  const bad = [];
  for (let k = 0; k < 500; k++) {
    const h1 = hex(0, 0, r), h2 = hex(d * Math.cos(Math.PI / 3), d * Math.sin(Math.PI / 3), r);
    const amp = 1e-9 * (1 + (k % 10));
    for (const pt of [h2[3].p1, h2[3].p2]) { pt.x += rand() * amp; pt.y += rand() * amp; }
    const regs = allRegions([...h1, ...h2]);
    const big = regs.filter(x => x.area > 1e-6);
    if (big.length !== 2 || regs.length !== 2) bad.push(`try ${k}: ${regs.map(x => x.area.toFixed(4)).join(', ')}`);
  }
  assert.deepEqual(bad, []);
});

test('an area keeps its colour, not the colour of an island in its hole', () => {
  // Painted square A (green) shares an edge with square C and holds an
  // island B (red) in a hole. C moves away: A's outline changes (C's edge
  // leaves it), so A has no exact match, but it must stay green.
  const A = square(0, 0, 10), B = square(4, 4, 2), C = square(10, 0, 10);
  const ents = [...A, ...B, ...C];
  const fills = [paint(ents, { x: 1, y: 1 }, 'green'), paint(ents, { x: 5, y: 5 }, 'red'), paint(ents, { x: 15, y: 5 }, 'blue')];
  const refs = referenceRegions(fills, ents);
  for (const p of new Set(C.flatMap(l => [l.p1, l.p2]))) p.x += 0.5;
  const { fills: out } = reconcileRegions(refs, ents, mk);
  assert.equal(colourAt(out, { x: 1, y: 1 }), 'green', 'A');
  assert.equal(colourAt(out, { x: 5, y: 5 }), 'red', 'island B');
  assert.equal(colourAt(out, { x: 15.5, y: 5 }), 'blue', 'C');
});

test('scrubbing a variable never changes fill colours (hexagon pitch drawing)', () => {
  const json = JSON.parse(readFileSync(new URL('../fixtures/hex-pitch.json', import.meta.url), 'utf8'));
  const p = Project.fromJSON(json);
  const s = p.active();
  ensureDimensionNames(p);
  const layer = 'ly305';
  const shapes = () => s.entities.filter(e => !e.construction && e.layerId === layer && ['line', 'arc', 'circle'].includes(e.constructor.kind));
  for (const f of s.fills) f.region = findFaceAt(shapes(), f.seed);
  const refs = referenceRegions(s.fills, shapes());
  const solver = new Solver();
  const byId = (id) => { for (const e of s.entities) { if (e.id === id) return e; for (const c of e.children()) if (c.id === id) return c; } };
  const probes = (c1, c2) => [
    [{ x: c1.x - 2.2, y: c1.y - 0.5 }, '#c9a400', 'hexagon 1'], [{ x: c2.x + 2.2, y: c2.y + 0.5 }, '#8a4fd1', 'hexagon 2'],
    [{ x: c1.x + 0.5, y: c1.y + 1.6 }, '#d63a3a', 'square 1'], [{ x: c2.x + 0.5, y: c2.y - 0.6 }, '#d63a3a', 'square 2'],
  ];
  const bad = [];
  // Like a scrub: each step starts from the previous solution.
  for (const pitch of [6.17, 6.22, 6.27, 6.42, 6.32, 6.22, 6.12, 6.02, 5.92, 5.72, 5.52, 5.72, 6.12, 6.62, 7.12, 6.12]) {
    p.variables[0].expr = String(pitch);
    solveEquations(p, (c, v) => { c.value = internalValue(c, v); });
    solver.solve(s, p.sketches, [], { diagnostics: false, revertOnFailure: true });
    const { fills } = reconcileRegions(refs, shapes(), mk);
    if (fills.length !== 8) bad.push(`pitch ${pitch}: ${fills.length} fills, want 8`);
    for (const [pt, want, note] of probes(byId('e1409'), byId('e1440'))) {
      const got = colourAt(fills, pt);
      if (got !== want) bad.push(`pitch ${pitch}: ${note} ${got}, want ${want}`);
    }
  }
  assert.deepEqual(bad, []);
});

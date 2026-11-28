// The sketch format beyond lines and circles: curves, polygons, mirror,
// offsets, patterns, signed angles, circle distances, held values,
// variables, formulas, sliders, reference dimensions, display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFromSpec, projectToSpec, SpecError } from '../../app/src/core/spec.js';
import { Project } from '../../app/src/core/model.js';
import { Arc, Bezier, Circle, Line } from '../../app/src/core/entities.js';
import { Solver } from '../../app/src/core/solver.js';
import { solveEquations, internalValue } from '../../app/src/core/equations.js';
import { placePatternCopies } from '../../app/src/core/patterns.js';
import { near, pngDataUrl } from './helpers.js';

const load = (p) => Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
const kinds = (p) => p.active().entities.map(e => e.constructor.kind).sort().join();
const cons = (p) => p.active().constraints.map(c => c.kind + (c.driven ? '*' : '')).sort().join();
const problems = (spec) => {
  try { buildFromSpec(spec); } catch (e) { if (e instanceof SpecError) return e.problems.join('\n'); throw e; }
  assert.fail('expected a SpecError');
};
/** Built → saved → loaded → read back as a spec → built again: the same sketch. */
function roundTrip(spec) {
  const { project } = buildFromSpec(spec);
  const { spec: back, lossless, unsupported } = projectToSpec(load(project));
  assert.equal(lossless, true, `lossless (${unsupported.join(', ')})`);
  const again = buildFromSpec(back).project;
  assert.equal(kinds(again), kinds(project), 'same shapes');
  assert.equal(cons(again), cons(project), 'same relations');
  return { project, again, back };
}

test('curves: one Bézier, a smooth path through points, tangent to a line, a point on a curve', () => {
  const spec = {
    shapes: [
      { id: 'path', type: 'curve', points: [[0, 0], [10, 6], [20, 0], [30, 6]] },
      { id: 'lead', type: 'line', from: [-10, -6], to: [0, 0] },
      { id: 'one', type: 'curve', from: [0, 20], to: [20, 20], c1: [5, 30], c2: [15, 30] },
      { id: 'pin', type: 'point', at: [10, 27.5] },
    ],
    constraints: [{ type: 'tangent', a: 'path.s1', b: 'lead' }, { type: 'on', point: 'pin', shape: 'one' }],
  };
  const { project, report } = buildFromSpec(spec);
  const s = project.active();
  assert.equal(s.entities.filter(e => e instanceof Bezier).length, 4);
  assert.equal(s.constraints.filter(c => c.kind === 'smooth').length, 2, 'smooth at the two inner points');
  assert.ok(s.constraints.some(c => c.kind === 'curveTangent'));
  assert.ok(s.constraints.some(c => c.kind === 'pointOnCurve'));
  // the path's first handle now points along the lead line
  const seg = s.entities.find(e => e instanceof Bezier);
  const lead = s.entities.find(e => e instanceof Line);
  const hx = seg.c1.x - seg.p1.x, hy = seg.c1.y - seg.p1.y, lx = lead.p2.x - lead.p1.x, ly = lead.p2.y - lead.p1.y;
  assert.ok(Math.abs(hx * ly - hy * lx) / Math.hypot(hx, hy) / Math.hypot(lx, ly) < 1e-6, 'tangent');
  assert.equal(report.state, 'under');
  roundTrip(spec);
});

test('a closed smooth curve can be filled', () => {
  const { project } = buildFromSpec({
    shapes: [{ id: 'blob', type: 'curve', points: [[0, 0], [20, -4], [26, 14], [6, 20]], closed: true }],
    fills: [{ at: [12, 8], color: '#ffd6a5' }],
  });
  assert.equal(project.active().fills.length, 1);
});

test('regular polygon, as the Polygon tool makes it, fully defined by its circle', () => {
  const spec = {
    shapes: [{ id: 'hex', type: 'polygon', center: [0, 0], sides: 6, side: 10 }],
    constraints: [{ type: 'fix', point: 'hex.center' }, { type: 'radius', shape: 'hex.circle', value: 10 }, { type: 'vertical', line: 'hex.s2' }],
  };
  const { project, report } = buildFromSpec(spec);
  assert.equal(report.state, 'fully');
  const lines = project.active().entities.filter(e => e instanceof Line);
  assert.equal(lines.length, 6);
  assert.ok(lines.every(l => near(Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y), 10, 1e-6)));
  assert.ok(project.active().entities.find(e => e instanceof Circle).construction);
  roundTrip(spec);
});

test('mirror: lines, circles, arcs and curves copied and tied by symmetry; points on the axis are shared', () => {
  const spec = {
    shapes: [
      { id: 'ax', type: 'line', from: [0, -20], to: [0, 30], construction: true },
      { id: 'half', type: 'polyline', points: [[0, -10], [8, -10], [8, 10], [0, 10]] },
      { id: 'h', type: 'circle', center: [4, 0], r: 2 },
      { id: 'cap', type: 'arc', center: [0, 10], from: [4, 10], to: [0, 14] },
      { id: 'cv', type: 'curve', from: [8, -10], to: [12, 0], c1: [10, -8], c2: [12, -4] },
      { id: 'm', type: 'mirror', of: ['half', 'h', 'cap', 'cv'], axis: 'ax' },
    ],
    constraints: [{ type: 'length', line: 'half.s2', value: 20 }],
  };
  const { project } = buildFromSpec(spec);
  const s = project.active();
  assert.equal(s.entities.filter(e => e instanceof Line).length, 1 + 3 * 2);
  assert.equal(s.entities.filter(e => e instanceof Arc).length, 2);
  // the outline is closed across the axis: the top and bottom points are shared
  const ends = s.entities.filter(e => e instanceof Line && !e.construction).flatMap(l => [l.p1, l.p2]);
  const onAxis = ends.filter(p => Math.abs(p.x) < 1e-9);
  assert.equal(new Set(onAxis).size, 2);
  // change the seed: the copy follows
  for (const c of s.constraints) if (c.kind === 'distance') c.value = 30;
  assert.ok(new Solver().solve(s, [s], [], { diagnostics: true }).ok);
  const xs = ends.map(p => p.x);
  assert.ok(near(Math.max(...xs), 8) && near(Math.min(...xs), -8));
  const ys = ends.map(p => p.y);
  assert.ok(near(Math.max(...ys) - Math.min(...ys), 30, 1e-6), 'both halves grew');
  roundTrip(spec);
});

test('offset: lines and circles at one editable distance', () => {
  const spec = {
    shapes: [
      { id: 'a', type: 'line', from: [0, 0], to: [10, 0] }, { id: 'b', type: 'line', from: [0, 3], to: [10, 3] },
      { id: 'c1', type: 'circle', center: [30, 0], r: 5 }, { id: 'c2', type: 'circle', center: [30, 0], r: 8 },
    ],
    constraints: [{ type: 'offset', pairs: [['a', 'b'], ['c1', 'c2']], value: 3, name: 'wall' }],
  };
  const { project } = buildFromSpec(spec);
  const s = project.active();
  const d = s.constraints.find(c => c.kind === 'offsetDistance');
  assert.equal(d.name, 'wall');
  d.value = 5; for (const p of d.pairs) p.value = Math.sign(p.value) * 5;
  assert.ok(new Solver().solve(s, [s], [], { diagnostics: true }).ok);
  const [, b] = s.entities.filter(e => e instanceof Line);
  const [c1, c2] = s.entities.filter(e => e instanceof Circle);
  assert.ok(near(b.p1.y - s.entities[0].p1.y, 5, 1e-6) && near(c2.r - c1.r, 5, 1e-6));
  roundTrip(spec);
});

test('patterns: linear in two directions, circular, and to points; copies follow the seed', () => {
  const spec = {
    shapes: [
      { id: 'c', type: 'point', at: [100, 0] },
      { id: 'h', type: 'circle', center: [0, 0], r: 2 },
      { id: 'grid', type: 'pattern', kind: 'linear', of: ['h'], count: 4, spacing: 10, count2: 3, spacing2: 8 },
      { id: 'bolt', type: 'circle', center: [120, 0], r: 3 },
      { id: 'ring', type: 'pattern', kind: 'circular', of: ['bolt'], center: 'c', count: 6 },
      { id: 'mark', type: 'polyline', points: [[0, 50], [4, 50], [2, 54]], closed: true },
      { id: 't1', type: 'point', at: [20, 60] }, { id: 't2', type: 'point', at: [40, 70] },
      { id: 'pp', type: 'pattern', kind: 'points', of: ['mark'], origin: [0, 50], targets: ['t1', 't2'] },
    ],
    constraints: [{ type: 'radius', shape: 'h', value: 2 }],
  };
  const { project } = buildFromSpec(spec);
  const s = project.active();
  assert.equal(s.entities.filter(e => e instanceof Circle).length, 12 + 6);
  assert.equal(s.entities.filter(e => e instanceof Line).length, 3 * 3);
  const bolts = s.entities.filter(e => e instanceof Circle && near(e.r, 3));
  assert.ok(bolts.every(b => near(Math.hypot(b.center.x - 100, b.center.y), 20, 1e-6)), 'round the centre');
  // the seed grows: its copies grow with it
  s.constraints.find(c => c.kind === 'radius').value = 4;
  assert.ok(new Solver().solve(s, [s], [], { diagnostics: true }).ok);
  assert.equal(s.entities.filter(e => e instanceof Circle && near(e.r, 4, 1e-6)).length, 12);
  const { back } = roundTrip(spec);
  assert.equal(back.shapes.filter(x => x.type === 'pattern').length, 3, 'patterns read back, copies left out');
});

test('signed angles between point pairs, circle distances, held values, reference dimensions', () => {
  const spec = {
    points: { o: [0, 0] },
    shapes: [
      { id: 'l1', type: 'line', from: 'o', to: [10, 0] }, { id: 'l2', type: 'line', from: 'o', to: [0, 10] },
      { id: 'a', type: 'circle', center: [40, 0], r: 5 }, { id: 'b', type: 'circle', center: [60, 0], r: 3 },
      { id: 'arc', type: 'arc', center: [0, 40], r: 10, start_angle: 0, end_angle: 120 },
    ],
    constraints: [
      { type: 'angle', a: 'l1', b: ['o', 'l2.end'], value: 60, signed: true },
      { type: 'distance', a: 'a', b: 'b', value: 12 },
      { type: 'distance', a: 'a', b: 'b', mode: 'gap', reference: true },
      { type: 'fix', shape: 'arc', param: 'start_angle' }, { type: 'fix', shape: 'a', param: 'r' },
      { type: 'length', line: 'l2', reference: true },
    ],
  };
  const { project } = buildFromSpec(spec);
  const s = project.active();
  const [l1, l2] = s.entities.filter(e => e instanceof Line);
  const ang = Math.atan2(l2.p2.y - l2.p1.y, l2.p2.x - l2.p1.x) - Math.atan2(l1.p2.y - l1.p1.y, l1.p2.x - l1.p1.x);
  assert.ok(near(ang, Math.PI / 3, 1e-6), 'counter-clockwise 60°');
  const [a, b] = s.entities.filter(e => e instanceof Circle);
  assert.ok(near(Math.hypot(b.center.x - a.center.x, b.center.y - a.center.y) - a.r - b.r, 12, 1e-6));
  const refs = s.constraints.filter(c => c.driven);
  assert.equal(refs.length, 2);
  assert.ok(near(refs[0].value, 12, 1e-6), 'the reference gap measures the solved one');
  assert.ok(near(refs[1].value, Math.hypot(l2.p2.x - l2.p1.x, l2.p2.y - l2.p1.y), 1e-9), 'the reference length measures the line as solved');
  roundTrip(spec);
});

test('variables, formulas, named dimensions, sliders, display: and a change of variable resizes', () => {
  const spec = {
    variables: { W: { value: 80, slider: { min: 40, max: 120, step: 5 } }, H: 'W / 2', N: 4 },
    display: { names: true, grid: false },
    shapes: [
      { id: 'plate', type: 'rectangle', corner: [0, 0], width: 80, height: 40 },
      { id: 'h', type: 'circle', center: [10, 20], r: 3 },
      { id: 'row', type: 'pattern', kind: 'linear', of: ['h'], count: 'N', spacing: 'W / 5' },
    ],
    constraints: [
      { type: 'fix', point: 'plate.bl' },
      { type: 'length', line: 'plate.bottom', value: 'W', name: 'width' },
      { type: 'length', line: 'plate.left', value: 'H' },
      { type: 'radius', shape: 'h', value: 3 },
      { type: 'distance', a: 'plate.bl', b: 'h.center', axis: 'x', value: 'width / 8' },
      { type: 'distance', a: 'plate.bl', b: 'h.center', axis: 'y', value: 'H / 2' },
    ],
  };
  const { project, report } = buildFromSpec(spec);
  assert.equal(report.state, 'fully');
  assert.deepEqual(project.variables.map(v => v.name), ['W', 'H', 'N']);
  assert.deepEqual({ min: project.variables[0].slider.min, max: project.variables[0].slider.max, step: project.variables[0].slider.step }, { min: 40, max: 120, step: 5 });
  assert.equal(project.display.dimNames, true);
  assert.equal(project.display.grid, false);
  const s = project.active();
  assert.ok(s.constraints.some(c => c.name === 'width' && c.expr === 'W'));
  const centers = () => s.entities.filter(e => e instanceof Circle).map(c => c.center.x).sort((a, b) => a - b);
  assert.deepEqual(centers().map(x => +x.toFixed(6)), [10, 26, 42, 58]);
  // as the slider does it: W = 100 → everything follows
  project.variables[0].expr = '100';
  solveEquations(project, (c, v) => { c.value = internalValue(c, v); });
  const pat = s.constraints.find(c => c.kind === 'pattern');
  pat.params.d1.spacing = 20;                       // what the editor's pattern equations do
  placePatternCopies(s, pat);
  assert.ok(new Solver().solve(s, [s], [], { diagnostics: true }).ok);
  const bottom = s.entities.find(e => e instanceof Line);
  assert.ok(near(Math.abs(bottom.p2.x - bottom.p1.x), 100, 1e-6));
  assert.ok(near(centers()[0], 12.5, 1e-6));
  const { back } = roundTrip(spec);
  assert.equal(back.variables.H, 'W / 2');
  assert.equal(back.variables.W.slider.step, 5);
  assert.equal(back.shapes.find(x => x.type === 'pattern').spacing, 'W / 5');
  assert.ok(back.constraints.some(c => c.value === 'width / 8'));
  assert.deepEqual(back.display, { grid: false, names: true });
});

test('problems with the new parts are named', () => {
  assert.match(problems({ shapes: [{ type: 'polygon', center: [0, 0], sides: 2, r: 5 }] }), /"sides" is a whole number from 3/);
  assert.match(problems({ shapes: [{ type: 'curve', from: [0, 0], to: [1, 0] }] }), /"c1", "c2"/);
  assert.match(problems({ shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }, { type: 'mirror', of: ['l'], axis: 'nope' }] }), /unknown shape "nope"/);
  assert.match(problems({ shapes: [{ id: 'h', type: 'circle', center: [0, 0], r: 1 }, { type: 'pattern', kind: 'spiral', of: ['h'] }] }), /"kind" is "linear"/);
  assert.match(problems({ shapes: [{ id: 'h', type: 'circle', center: [0, 0], r: 1 }, { type: 'pattern', kind: 'linear', of: ['h'], count: 3 }] }), /"spacing"/);
  assert.match(problems({ shapes: [{ id: 'c', type: 'curve', from: [0, 0], to: [9, 0], c1: [3, 3], c2: [6, 3] }], constraints: [{ type: 'smooth', point: 'c.end' }] }), /exactly two curves/);
  assert.match(problems({ variables: { W: 'X + 1' }, shapes: [{ type: 'point', at: [0, 0] }] }), /variables\.W: Unknown name "X"/);
  assert.match(problems({ variables: { W: 10 }, shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }], constraints: [{ type: 'length', line: 'l', value: 5, name: 'W' }] }), /used twice/);
  assert.match(problems({ shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }], constraints: [{ type: 'length', line: 'l', reference: true, value: 'L * 2' }] }), /reference dimension measures/);
  assert.match(problems({ display: { zoom: 3 }, shapes: [{ type: 'point', at: [0, 0] }] }), /display:/);
});

/* ---- pictures and traced paths ---- */
import { imageSource } from '../../app/src/core/images.js';
import { pathComponent, pathFingerprint } from '../../app/src/core/trace.js';

test('pictures: placed to scale, proportions kept, linked; read back as a short reference', () => {
  const src = pngDataUrl(40, 20);
  const spec = {
    shapes: [{ id: 'wall', type: 'line', from: [0, 0], to: [100, 0] }],
    drawing: [{ type: 'image', src, center: [50, 20], width: 30, link: 'wall' }],
  };
  const { project } = buildFromSpec(spec);
  const img = project.active().strokes[0];
  assert.equal(img.kind, 'image');
  const [a, b, c] = img.points;
  assert.ok(near(b.x - a.x, 30) && near(a.y - c.y, 15), '30 wide, 15 high (2:1)');
  assert.equal(img.link.to, project.active().entities[0].id);
  const json = project.toJSON();
  assert.equal(json.images[img.image], src, 'the picture is saved with the sketch');
  const { spec: back, lossless } = projectToSpec(Project.fromJSON(JSON.parse(JSON.stringify(json))));
  assert.equal(lossless, true);
  assert.equal(back.drawing[0].src, `image:${img.image}`, 'no picture data in what the assistant reads');
  // sent back unchanged: the picture is kept
  const again = buildFromSpec(back, { images: json.images }).project;
  assert.equal(again.toJSON().images[img.image], src);
  assert.equal(imageSource(img.image), src);
});

test('a traced path: computed, and up to date for the editor', () => {
  const spec = {
    points: { o: [0, 0] },
    shapes: [
      { id: 'crank', type: 'line', from: 'o', to: [5, 8.660254] },              // at 60°, not at a dead point
      { id: 'rod', type: 'line', from: 'crank.end', to: [28.452079, 0] },
      { id: 'rail', type: 'line', from: [-40, 0], to: [60, 0], construction: true },
    ],
    constraints: [
      { type: 'fix', point: 'o' }, { type: 'length', line: 'crank', value: 10 }, { type: 'length', line: 'rod', value: 25 },
      { type: 'on', point: 'rod.end', shape: 'rail' }, { type: 'fix', point: 'rail.start' }, { type: 'fix', point: 'rail.end' },
    ],
    drawing: [
      { type: 'trace', point: 'crank.end', color: '#1f7ad6' },
      { type: 'trace', point: 'rod.end', color: '#d63a3a' },
    ],
  };
  const { project } = buildFromSpec(spec);
  const s = project.active();
  const [crankPath, slider] = s.strokes;
  assert.equal(crankPath.traces.closed, true, 'the crank end goes round');
  assert.ok(crankPath.points.every(p => near(Math.hypot(p.x, p.y), 10, 0.05)), 'on a circle of radius 10');
  const xs = slider.points.map(p => p.x);
  assert.ok(near(Math.min(...xs), 15, 0.05) && near(Math.max(...xs), 35, 0.05), 'the slider travels 15 to 35');
  assert.ok(slider.points.every(p => Math.abs(p.y) < 1e-6));
  // the editor's fingerprint of the loaded sketch matches: not out of date
  const loaded = Project.fromJSON(JSON.parse(JSON.stringify(project.toJSON())));
  const ls = loaded.active();
  const pt = ls.entities.flatMap(e => [e, ...e.children()]).find(x => x.id === crankPath.traces.point);
  assert.equal(pathFingerprint(pt, pathComponent(loaded, ls, pt)), ls.strokes[0].traces.fp);
  const { spec: back } = projectToSpec(loaded);
  assert.deepEqual(back.drawing.map(d => d.type), ['trace', 'trace']);
  assert.match(problems({ ...spec, drawing: [{ type: 'trace', point: 'o' }] }), /can't move|is fixed/);
});

/* ---- concept sketches and mechanisms ---- */
import { sweepVariable } from '../../app/src/core/sweep.js';
import { textCenter } from '../../app/src/core/strokes.js';
import { anchorLookup, syncLinks } from '../../app/src/core/ink-links.js';

test('bar: two pivots and a width; only the pivots are free; holes optional', () => {
  const { project, report } = buildFromSpec({ shapes: [{ id: 'link', type: 'bar', from: [0, 0], to: [40, 10], width: 8, hole: 3 }] });
  assert.equal(report.dof, 4, 'the two pivots');
  const s = project.active();
  assert.equal(s.entities.filter(e => e instanceof Arc).length, 2);
  assert.equal(s.entities.filter(e => e instanceof Circle).length, 2);
  const sides = s.entities.filter(e => e instanceof Line && !e.construction);
  for (const l of sides) assert.ok(near(Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y), Math.hypot(40, 10), 1e-6));
  assert.match(problems({ shapes: [{ type: 'bar', from: [0, 0], to: [0, 0], width: 3 }] }), /same point/);
  assert.match(problems({ shapes: [{ type: 'bar', from: [0, 0], to: [9, 0], width: 3, hole: 4 }] }), /less than the width/);
});

test('swept trace: a slider-driven mechanism draws its path; failures are named', () => {
  const crank = {
    variables: { a: 60 }, points: { o: [0, 0] },
    shapes: [
      { id: 'ground', type: 'line', from: [-20, 0], to: [70, 0], construction: true },
      { id: 'crank', type: 'bar', from: 'o', to: [5, 8.660254], width: 4 },
      { id: 'rod', type: 'bar', from: 'crank.end', to: [28.452079, 0], width: 4 },
    ],
    constraints: [
      { type: 'fix', point: 'o' }, { type: 'fix', point: 'ground.start' }, { type: 'fix', point: 'ground.end' },
      { type: 'length', line: 'crank.axis', value: 10 }, { type: 'length', line: 'rod.axis', value: 25 },
      { type: 'on', point: 'rod.end', shape: 'ground' }, { type: 'angle', a: 'ground', b: 'crank.axis', value: 'a', signed: true },
    ],
  };
  const { project, report } = buildFromSpec({ ...crank, drawing: [{ type: 'trace', point: 'crank.end', sweep: { variable: 'a', from: 0, to: 360, steps: 36 } }] });
  assert.equal(report.state, 'fully');
  const path = project.active().strokes[0];
  assert.equal(path.points.length, 37);
  assert.ok(path.points.every(p => near(Math.hypot(p.x, p.y), 10, 1e-6)), 'a circle of radius 10');
  assert.ok(near(project.active().entities.find(e => e instanceof Line && e.construction && e.p1.x === 0 && e.p1.y === 0)?.p2.x ?? 5, 5, 1e-6), 'the sketch is back where it was');
  // an unswept trace of a driven point says how to do it
  assert.match(problems({ ...crank, drawing: [{ type: 'trace', point: 'crank.end' }] }), /"sweep": \{ "variable": "a"/);
  // the sweep stops where the mechanism can't follow
  let last = null;
  const r = sweepVariable(project, { variable: 'a', from: 0, to: 90, steps: 9 }, (v) => { last = v; });
  assert.equal(r.ok, true); assert.equal(last, 90);
});

test('bent arrows, part links that turn, fill-only shapes, offsets drawn either way', () => {
  const { project } = buildFromSpec({
    variables: { a: 30 },
    shapes: [
      { id: 'arm', type: 'bar', from: [0, 0], to: [40, 0], width: 6 },
      { id: 'x', type: 'line', from: [0, 0], to: [10, 0], construction: true },
      { id: 'src', type: 'line', from: [0, -20], to: [40, -20] }, { id: 'copy', type: 'line', from: [40, -24], to: [0, -24] },
    ],
    constraints: [
      { type: 'fix', point: 'arm.start' }, { type: 'fix', point: 'x.end' }, { type: 'length', line: 'arm.axis', value: 40 },
      { type: 'angle', a: 'x', b: 'arm.axis', value: 'a', signed: true },
      { type: 'offset', a: 'src', b: 'copy', value: 4 },
    ],
    drawing: [
      { id: 'lift', type: 'arrow', from: [30, 30], to: [45, 10], bend: 0.3, tips: 'both' },
      { id: 'tag', type: 'text', text: 'ARM', at: [25, 15], link: 'arm' },
      { id: 'blob', type: 'shape', shape: 'ellipse', center: [20, 0], width: 10, height: 6, fill: 'solid', outline: 'none' },
    ],
  });
  const s = project.active();
  const [curve, head1, head2] = s.strokes;
  assert.equal(curve.kind, 'pen'); assert.equal(head1.kind, 'arrow'); assert.equal(head2.kind, 'arrow');
  assert.ok(curve.group && curve.group === head1.group && head1.group === head2.group, 'one group');
  assert.ok(near(head1.points[1].x, 45) && near(head1.points[1].y, 10), 'a head on the tip');
  const mid = curve.points[16];
  assert.ok(Math.hypot(mid.x - 37.5, mid.y - 20) > 3, 'the curve bows out');
  // the label follows the whole bar, turning with it
  const tag = s.strokes.find(k => k.kind === 'text');
  const before = textCenter(tag);
  const angle = s.constraints.find(c => c.kind === 'directedAngle');
  angle.value += Math.PI / 2;
  assert.ok(new Solver().solve(s, [s], [], { diagnostics: true }).ok);
  syncLinks(s.strokes, anchorLookup([s]));
  const after = textCenter(tag);
  assert.ok(near(Math.hypot(after.x, after.y), Math.hypot(before.x, before.y), 1e-6), 'same distance from the pivot');
  assert.ok(Math.abs(Math.atan2(after.y, after.x) - Math.atan2(before.y, before.x) - Math.PI / 2) < 1e-6, 'turned by 90°');
  assert.equal(s.strokes.find(k => k.kind === 'shape').width, 0);
  const copy = s.entities.filter(e => e instanceof Line && !e.construction).at(-1);
  assert.ok(near(copy.p1.y, -24, 1e-6), 'reversed copy at 4');
});

test('contradictions name the constraints whose removal fixes them', () => {
  const msg = problems({
    shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [10, 0] }, { id: 'm', type: 'line', from: [0, 0], to: [0, 10] }],
    constraints: [{ type: 'fix', point: 'l.start' }, { type: 'length', line: 'l', value: 10 }, { type: 'length', line: 'm', value: 10 },
      { type: 'perpendicular', a: 'l', b: 'm' }, { type: 'distance', a: 'l.end', b: 'm.end', value: 30 }],
  });
  assert.match(msg, /Removing any one of these makes it solvable: .*constraints\[4\] \(distance\)/);
  const over = problems({
    shapes: [{ id: 'r', type: 'rectangle', corner: [0, 0], width: 40, height: 20 }, { id: 'o', type: 'rectangle', corner: [-3, -3], width: 46, height: 26 }],
    constraints: [{ type: 'offset', pairs: [['r.bottom', 'o.bottom'], ['r.right', 'o.right']], value: 3 }],
  });
  assert.match(over, /Remove one of: constraints\[0\] \(offset\)/);
  assert.match(over, /draw them as polylines/);
});

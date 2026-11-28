import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFromSpec, projectToSpec, SpecError } from '../../app/src/core/spec.js';
import { Project } from '../../app/src/core/model.js';
import { Arc, Circle, Line, Point } from '../../app/src/core/entities.js';
import { near } from './helpers.js';

const problems = (spec) => {
  try { buildFromSpec(spec); } catch (e) { if (e instanceof SpecError) return e.problems.join('\n'); throw e; }
  assert.fail('expected a SpecError');
};
const lines = (p) => p.active().entities.filter(e => e instanceof Line);
const roundTrip = (p) => Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));

test('a fully defined bracket: rectangle, two holes, dimensions', () => {
  const { project, report } = buildFromSpec({
    title: 'Bracket',
    shapes: [
      { id: 'plate', type: 'rectangle', corner: [0, 0], width: 40, height: 20 },
      { id: 'h1', type: 'circle', center: [10, 10], d: 5 },
      { id: 'h2', type: 'circle', center: [30, 10], d: 5 },
    ],
    constraints: [
      { type: 'fix', point: 'plate.bl' },
      { type: 'length', line: 'plate.bottom', value: 40 },
      { type: 'length', line: 'plate.left', value: 20 },
      { type: 'diameter', shape: 'h1', value: 5 },
      { type: 'equal', a: 'h1', b: 'h2' },
      { type: 'distance', a: 'plate.bl', b: 'h1.center', axis: 'x', value: 10 },
      { type: 'distance', a: 'plate.bl', b: 'h1.center', axis: 'y', value: 10 },
      { type: 'distance', a: 'h1.center', b: 'h2.center', axis: 'x', value: 20 },
      { type: 'horizontal', a: 'h1.center', b: 'h2.center' },
    ],
  });
  assert.equal(report.state, 'fully');
  assert.equal(report.dof, 0);
  assert.equal(project.name, 'Bracket');
  const s = project.active();
  assert.equal(lines(project).length, 4);
  // the rectangle's corners are shared: 4 points, not 8
  const pts = new Set(lines(project).flatMap(l => [l.p1, l.p2]));
  assert.equal(pts.size, 4);
  const holes = s.entities.filter(e => e instanceof Circle);
  assert.ok(holes.every(c => near(c.r, 2.5)));
  // survives a save / load
  const back = roundTrip(project);
  assert.equal(back.active().entities.length, s.entities.length);
  assert.equal(back.active().constraints.length, s.constraints.length);
});

test('ends at the same coordinates join; named points are shared', () => {
  const { project } = buildFromSpec({
    points: { A: [0, 0], B: [10, 0] },
    shapes: [
      { type: 'line', from: 'A', to: 'B' },
      { type: 'line', from: [10, 0], to: [10, 5] },
      { type: 'line', from: [10, 5], to: 'A' },
    ],
  });
  const ls = lines(project);
  assert.equal(ls[0].p2, ls[1].p1);
  assert.equal(ls[1].p2, ls[2].p1);
  assert.equal(ls[2].p2, ls[0].p1);
});

test('closed polyline with named segments; constraints on them', () => {
  const { report, project } = buildFromSpec({
    shapes: [{ id: 'tri', type: 'polyline', points: [[0, 0], [30, 0], [0, 20]], closed: true }],
    constraints: [
      { type: 'horizontal', line: 'tri.s1' },
      { type: 'vertical', line: 'tri.s3' },
      { type: 'length', line: 'tri.s1', value: 30 },
      { type: 'length', line: 'tri.s3', value: 20 },
      { type: 'fix', point: 'tri.p1' },
    ],
  });
  assert.equal(report.state, 'fully');
  assert.equal(lines(project).length, 3);
});

test('slot: two lines and two arcs joined end to end, tangent', () => {
  const { project, report } = buildFromSpec({
    points: { a: [0, 0], b: [20, 0], c: [20, 10], d: [0, 10] },
    shapes: [
      { id: 'bottom', type: 'line', from: 'a', to: 'b' },
      { id: 'right', type: 'arc', center: [20, 5], from: 'b', to: 'c' },
      { id: 'top', type: 'line', from: 'c', to: 'd' },
      { id: 'left', type: 'arc', center: [0, 5], from: 'd', to: 'a' },
    ],
    constraints: [
      { type: 'tangent', a: 'bottom', b: 'right' },
      { type: 'tangent', a: 'top', b: 'right' },
      { type: 'tangent', a: 'bottom', b: 'left' },
      { type: 'tangent', a: 'top', b: 'left' },
      { type: 'equal', a: 'right', b: 'left' },
      { type: 'radius', shape: 'right', value: 5 },
      { type: 'length', line: 'bottom', value: 20 },
      { type: 'horizontal', line: 'bottom' },
      { type: 'fix', point: 'a' },
    ],
  });
  assert.equal(report.state, 'fully', JSON.stringify(report));
  const arcs = project.active().entities.filter(e => e instanceof Arc);
  assert.equal(arcs.length, 2);
  for (const a of arcs) assert.ok(near(a.r, 5));
  // arc ends sit on the line ends after solving
  const right = arcs.find(a => near(a.center.x, 20, 1e-6));
  assert.ok(near(right.start.x, 20) && near(right.start.y, 0));
  assert.ok(near(right.end.y, 10));
});

test('arc by angles; arcs meeting only each other are tied end to end', () => {
  const { project } = buildFromSpec({
    shapes: [
      { id: 'a1', type: 'arc', center: [0, 0], r: 10, start_angle: 0, end_angle: 90 },
      { id: 'a2', type: 'arc', center: [0, 20], r: 10, start_angle: 270, end_angle: 180, clockwise: true },
    ],
  });
  const s = project.active();
  assert.equal(s.entities.length, 2, 'no extra point where the arcs meet');
  assert.ok(s.constraints.some(c => c.kind === 'arcEndpointArcEndpointCoincident'));
});

test('angle dimension measures the drawn sector', () => {
  const { project, report } = buildFromSpec({
    points: { o: [0, 0] },
    shapes: [
      { id: 'base', type: 'line', from: 'o', to: [10, 0] },
      { id: 'arm', type: 'line', from: 'o', to: [-5, 8] },
    ],
    constraints: [{ type: 'angle', a: 'base', b: 'arm', value: 120 }],
  });
  assert.equal(report.state, 'under');
  const [base, arm] = lines(project);
  const ang = Math.atan2(arm.p2.y - arm.p1.y, arm.p2.x - arm.p1.x) - Math.atan2(base.p2.y - base.p1.y, base.p2.x - base.p1.x);
  assert.ok(near(Math.abs(ang) * 180 / Math.PI, 120, 1e-5));
});

test('coincident merges points; point-line distance; on, midpoint, symmetric', () => {
  const { report } = buildFromSpec({
    shapes: [
      { id: 'axis', type: 'line', from: [0, -10], to: [0, 10], construction: true },
      { id: 'l', type: 'line', from: [-5, 3], to: [5, 3] },
      { id: 'm', type: 'point', at: [0, 3] },
      { id: 'c', type: 'circle', center: [0, 0], r: 3 },
      { id: 'q', type: 'point', at: [3, 0.2] },
      { id: 'side', type: 'point', at: [4, 8] },
    ],
    constraints: [
      { type: 'symmetric', a: 'l.start', b: 'l.end', axis: 'axis' },
      { type: 'midpoint', point: 'm', line: 'l' },
      { type: 'distance', a: 'side', b: 'axis', value: 4 },
      { type: 'on', point: 'q', shape: 'c' },
      { type: 'coincident', a: 'c.center', b: [0, 0] },
    ],
  });
  assert.ok(['under', 'fully'].includes(report.state));
});

test('clear problems for bad input', () => {
  assert.match(problems({}), /shapes/);
  assert.match(problems({ shapes: [{ type: 'hexagon' }] }), /unknown type "hexagon"/);
  assert.match(problems({ shapes: [{ type: 'line', from: 'A', to: [1, 1] }] }), /unknown point "A"/);
  assert.match(problems({ shapes: [{ type: 'circle', center: [0, 0] }] }), /"r".*"d"/);
  assert.match(problems({ shapes: [{ type: 'line', from: [0, 0], to: [0, 0] }] }), /same point/);
  assert.match(problems({ shapes: [{ type: 'arc', center: [0, 0], from: [5, 0], to: [0, 7] }] }), /same distance/);
  assert.match(problems({
    shapes: [{ id: 'r', type: 'rectangle', corner: [0, 0], width: 1, height: 1 }],
    constraints: [{ type: 'horizontal', line: 'r' }],
  }), /"r\.bottom"/);
  assert.match(problems({
    shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }],
    constraints: [{ type: 'radius', shape: 'l', value: 2 }],
  }), /is a line; expected round/);
  assert.match(problems({
    shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }],
    constraints: [{ type: 'length', line: 'l', value: -1 }],
  }), /"value" must be a number > 0/);
});

test('contradictions and repeats are refused and named', () => {
  const contradict = problems({
    shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [10, 0] }],
    constraints: [
      { type: 'fix', point: 'l.start' }, { type: 'fix', point: 'l.end' },
      { type: 'length', line: 'l', value: 20 },
    ],
  });
  assert.match(contradict, /cannot all be met|repeat/);
  const repeat = problems({
    shapes: [{ id: 'r', type: 'rectangle', corner: [0, 0], width: 10, height: 5 }],
    constraints: [{ type: 'parallel', a: 'r.bottom', b: 'r.top' }],
  });
  assert.match(repeat, /repeat what others already fix/);
  assert.match(repeat, /constraints\[0\]/);
});

test('projectToSpec describes a drawn sketch and builds back the same', () => {
  const { project } = buildFromSpec({
    title: 'Round trip',
    points: { a: [0, 0], b: [20, 0], c: [20, 10], d: [0, 10] },
    shapes: [
      { id: 'bottom', type: 'line', from: 'a', to: 'b' },
      { id: 'right', type: 'arc', center: [20, 5], from: 'b', to: 'c' },
      { id: 'top', type: 'line', from: 'c', to: 'd' },
      { id: 'left', type: 'line', from: 'd', to: 'a' },
      { id: 'hole', type: 'circle', center: [8, 5], d: 4 },
    ],
    constraints: [
      { type: 'horizontal', line: 'bottom' }, { type: 'vertical', line: 'left' },
      { type: 'tangent', a: 'bottom', b: 'right' }, { type: 'tangent', a: 'top', b: 'right' },
      { type: 'length', line: 'bottom', value: 20 }, { type: 'diameter', shape: 'hole', value: 4 },
      { type: 'fix', point: 'a' },
    ],
  });
  const loaded = roundTrip(project);
  const { spec, lossless } = projectToSpec(loaded);
  assert.equal(lossless, true);
  const again = buildFromSpec(spec).project;
  const kinds = (p) => p.active().entities.map(e => e.constructor.kind).sort();
  assert.deepEqual(kinds(again), kinds(project));
  const ck = (p) => p.active().constraints.map(c => c.kind).sort();
  assert.deepEqual(ck(again), ck(project));
});

test('projectToSpec flags what it cannot carry', () => {
  const p = new Project(); const s = p.addSketch();
  s.addEntity(new Line(new Point(0, 0), new Point(1, 0)));
  s.fills.push({ id: 'f1', layerId: p.layers[0].id, color: '#ff0000', opacity: 1, seed: { x: 0, y: 0 } });
  const r = projectToSpec(p);
  assert.equal(r.lossless, false);
  assert.deepEqual(r.unsupported, ['fills']);
});

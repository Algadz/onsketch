// Bézier curves: math, the entity, its relations (tangent, smooth, on
// curve), regions, saving, patterns, scissors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/src/core/constraints.js';
import { Bezier, Line, Point, bezierHandlesShown, isHiddenHandle } from '../../app/src/core/entities.js';
import { bezierAt, bezierBezierHits, bezierCircleHits, bezierLength, bezierLineHits, bezierNearest, bezierSplit, bezierSub } from '../../app/src/core/bezier.js';
import { Project } from '../../app/src/core/model.js';
import { allRegions } from '../../app/src/core/regions.js';
import { PatternConstraint, defaultPatternParams, syncPattern } from '../../app/src/core/patterns.js';
import { pieceAt, splitAt, splitSpot, trimAt } from '../../app/src/core/trim.js';
import { near, sketch, line, circle, solve } from './helpers.js';

const P = (...xy) => { const out = []; for (let i = 0; i < xy.length; i += 2) out.push({ x: xy[i], y: xy[i + 1] }); return out; };
function curve(s, ...xy) {
  const [a, b, c, d] = P(...xy).map(p => new Point(p.x, p.y));
  const e = new Bezier(a, b, c, d);
  s.addEntity(e);
  return e;
}

test('math: points, split, sub-curve, length, nearest', () => {
  const Q = P(0, 0, 0, 10, 10, 10, 10, 0);
  assert.deepEqual(bezierAt(Q, 0), { x: 0, y: 0 });
  assert.deepEqual(bezierAt(Q, 1), { x: 10, y: 0 });
  assert.ok(near(bezierAt(Q, 0.5).x, 5) && near(bezierAt(Q, 0.5).y, 7.5));
  const [a, b] = bezierSplit(Q, 0.3);
  assert.ok(near(bezierAt(a, 1).x, bezierAt(Q, 0.3).x) && near(bezierAt(b, 0.5).y, bezierAt(Q, 0.65).y));
  const m = bezierSub(Q, 0.2, 0.6);
  assert.ok(near(bezierAt(m, 0.5).x, bezierAt(Q, 0.4).x, 1e-9));
  const straight = P(0, 0, 1, 0, 2, 0, 3, 0);
  assert.ok(near(bezierLength(straight), 3, 1e-9));
  const n = bezierNearest(Q, { x: 5, y: 20 });
  assert.ok(near(n.t, 0.5, 1e-6) && near(n.d, 12.5, 1e-6));
});

test('math: crossings with a line, a circle and another curve', () => {
  const Q = P(0, 0, 0, 10, 10, 10, 10, 0);
  const lh = bezierLineHits(Q, { x: -5, y: 5 }, { x: 15, y: 5 });
  assert.equal(lh.length, 2);
  for (const h of lh) assert.ok(near(bezierAt(Q, h.t).y, 5, 1e-9));
  const ch = bezierCircleHits(Q, { x: 5, y: 0 }, 5);
  assert.ok(ch.length >= 2);
  for (const h of ch) assert.ok(near(Math.hypot(h.x - 5, h.y), 5, 1e-7));
  const R = P(0, 8, 3, -4, 7, -4, 10, 8);
  const bh = bezierBezierHits(Q, R);
  assert.equal(bh.length, 2);
  for (const h of bh) { const a = bezierAt(Q, h.t), b = bezierAt(R, h.s); assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-8); }
});

test('entity: four solver points, handles hidden until the curve is selected', () => {
  const s = sketch();
  const b = curve(s, 0, 0, 0, 10, 10, 10, 10, 0);
  assert.equal(b.children().length, 4);
  assert.ok(isHiddenHandle(b.c1));
  b.selected = true;
  assert.ok(bezierHandlesShown(b) && !isHiddenHandle(b.c1));
  b.selected = false; b.p2.selected = true;
  assert.ok(bezierHandlesShown(b));
  assert.ok(b.hit({ x: 5, y: 7.5 }, { zoom: 10 }) && !b.hit({ x: 5, y: 2 }, { zoom: 10 }));
  assert.equal(solve(s).dof, 8);
});

test('tangent: a curve end along a line, and tangent to a circle', () => {
  const s = sketch();
  const l = line(s, -10, 0, 0, 0);
  const b = new Bezier(l.p2, new Point(3, 4), new Point(8, 6), new Point(12, 0));
  s.addEntity(b);
  s.constraints.push(new C.FixConstraint(l.p1.id, -10, 0), new C.FixConstraint(l.p2.id, 0, 0), new C.FixConstraint(b.p2.id, 12, 0));
  s.constraints.push(new C.CurveTangentConstraint(b.p1.id, b.c1.id, { line: { a: l.p1.id, b: l.p2.id } }));
  assert.ok(solve(s).ok);
  assert.ok(near(b.c1.y, 0, 1e-6), 'handle on the line\'s direction');
  const s2 = sketch();
  const c = circle(s2, 0, 0, 5);
  const b2 = new Bezier(new Point(5, 0), new Point(7, 3), new Point(9, 4), new Point(12, 0));
  s2.addEntity(b2);
  s2.constraints.push(new C.FixConstraint(c.center.id, 0, 0), new C.FixConstraint(b2.p1.id, 5, 0));
  s2.constraints.push(new C.CurveTangentConstraint(b2.p1.id, b2.c1.id, { circle: c.id, centerId: c.center.id }));
  assert.ok(solve(s2).ok);
  assert.ok(near(b2.c1.x, 5, 1e-6), 'handle perpendicular to the radius');
});

test('smooth: two curves meet without a kink; one relation, no redundancy', () => {
  const s = sketch();
  const a = curve(s, 0, 0, 2, 5, 6, 5, 10, 0);
  const b = new Bezier(a.p2, new Point(13, 2), new Point(17, 5), new Point(20, 0));
  s.addEntity(b);
  s.constraints.push(new C.SmoothConstraint(a.p2.id, a.c2.id, b.c1.id));
  const r = solve(s);
  assert.ok(r.ok);
  const u = { x: a.p2.x - a.c2.x, y: a.p2.y - a.c2.y }, v = { x: b.c1.x - a.p2.x, y: b.c1.y - a.p2.y };
  assert.ok(Math.abs(u.x * v.y - u.y * v.x) / Math.hypot(v.x, v.y) < 1e-7);
  assert.equal(r.dof, 13);
  assert.equal(r.redundant, 0);
});

test('point on curve: a point is pulled onto the curve and stays on it', () => {
  const s = sketch();
  const b = curve(s, 0, 0, 0, 10, 10, 10, 10, 0);
  const q = new Point(5, 9); s.addEntity(q);
  s.constraints.push(new C.PointOnCurveConstraint(q.id, b.id, b.ctrl().map(p => p.id)));
  for (const p of b.ctrl()) s.constraints.push(new C.FixConstraint(p.id, p.x, p.y));
  const r = solve(s);
  assert.ok(r.ok);
  assert.ok(bezierNearest(b.ctrl(), q).d < 1e-6);
  assert.equal(r.dof, 1, 'it can still slide along');
});

test('regions: a curve closing a shape makes a fillable area', () => {
  const s = sketch();
  const l = line(s, 0, 0, 10, 0);
  s.addEntity(new Bezier(l.p2, new Point(10, 8), new Point(0, 8), l.p1));
  const regions = allRegions(s.entities);
  assert.equal(regions.length, 1);
});

test('saving: curves come back with shared ends and their relations', () => {
  const pr = new Project(); const s = pr.addSketch('S');
  const a = new Bezier(new Point(0, 0), new Point(2, 5), new Point(6, 5), new Point(10, 0));
  s.addEntity(a);
  const b = new Bezier(a.p2, new Point(13, -4), new Point(17, -4), new Point(20, 0));
  s.addEntity(b);
  s.constraints.push(new C.SmoothConstraint(a.p2.id, a.c2.id, b.c1.id));
  const back = Project.fromJSON(JSON.parse(JSON.stringify(pr.toJSON()))).sketches[0];
  const [a2, b2] = back.entities;
  assert.ok(a2 instanceof Bezier && b2 instanceof Bezier);
  assert.equal(a2.p2, b2.p1, 'shared anchor');
  assert.equal(a2.c1.bezierOwner, a2);
  assert.equal(back.constraints[0].kind, 'smooth');
  assert.equal(C.constraintLabel(back.constraints[0]), 'Smooth');
});

test('patterns copy curves (linked)', () => {
  const s = sketch();
  const b = curve(s, 0, 0, 0, 5, 5, 5, 5, 0);
  const p = defaultPatternParams('linear'); p.d1.count = 3; p.d1.spacing = 10;
  const c = new PatternConstraint('linear', p, [b.id]);
  syncPattern(s, c); s.constraints.push(c);
  const curves = s.entities.filter(e => e instanceof Bezier);
  assert.equal(curves.length, 3);
  assert.ok(near(curves[2].c1.x, 20) && near(curves[2].c1.y, 5));
  assert.ok(solve(s).ok);
});

test('scissors: a line trimmed back to a curve keeps its new end on the curve', () => {
  const s = sketch();
  curve(s, 0, -5, 3, 5, 7, -5, 10, 5);
  const h = line(s, -5, 0, 15, 0);
  const cuts = pieceAt(s, h, { x: -4, y: 0 });
  assert.ok(cuts.hi && cuts.hi.cutter instanceof Bezier);
  trimAt(s, h, { x: -4, y: 0 });
  assert.ok(s.constraints.some(c => c.kind === 'pointOnCurve'));
  assert.ok(solve(s).ok);
});

test('scissors: trim the middle of a curve, the far end keeps its relations', () => {
  const s = sketch();
  const b = curve(s, 0, 0, 0, 10, 10, 10, 10, 0);
  line(s, 3, -1, 3, 20); line(s, 7, -1, 7, 20);
  const end = line(s, 10, 0, 20, 0);
  s.constraints.push(new C.CurveTangentConstraint(b.p2.id, b.c2.id, { line: { a: end.p1.id, b: end.p2.id } }));
  const r = trimAt(s, b, { x: 5, y: 7.5 });
  const curves = s.entities.filter(e => e instanceof Bezier);
  assert.equal(curves.length, 2);
  const second = r.added[0];
  assert.equal(second.c2.bezierOwner, second);
  assert.ok(s.constraints.some(c => c.kind === 'curveTangent' && c.handleId === second.c2.id), 'the end tangent follows the far end');
  assert.ok(near(b.p2.x, 3) && near(second.p1.x, 7));
  assert.equal(s.constraints.filter(c => c.kind === 'pointOnLine').length, 2);
});

test('scissors: split a curve: two curves, same shape, a Smooth joint', () => {
  const s = sketch();
  const b = curve(s, 0, 0, 0, 10, 10, 10, 10, 0);
  const before = bezierAt(b.ctrl(), 0.25);
  const r = splitAt(s, b, splitSpot(s, b, { x: 5, y: 7.6 }));
  const c2 = r.added[0];
  assert.equal(b.p2, c2.p1);
  const after = bezierAt(b.ctrl(), 0.5);
  assert.ok(near(after.x, before.x, 1e-6) && near(after.y, before.y, 1e-6), 'shape kept');
  assert.equal(s.constraints[0].kind, 'smooth');
  assert.ok(solve(s).ok);
  void Line;
});

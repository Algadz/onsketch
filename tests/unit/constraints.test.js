// Each constraint, applied to deliberately "wrong" geometry, must be
// satisfied after one solve and must actually produce the geometric property.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/src/core/constraints.js';
import { near, ref, sketch, line, circle, arc, point, solve } from './helpers.js';

const len = (l) => Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y);
const dir = (l) => Math.atan2(l.p2.y - l.p1.y, l.p2.x - l.p1.x);

function solved(s) {
  const r = solve(s);
  assert.ok(r.residual < 1e-6, `residual ${r.residual}`);
  return r;
}

test('coincident', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0); const b = line(s, 11, 1, 20, 5);
  s.constraints.push(new C.CoincidentConstraint(a.p2.id, b.p1.id));
  solved(s);
  assert.ok(near(a.p2.x, b.p1.x) && near(a.p2.y, b.p1.y));
});

test('horizontal / vertical', () => {
  const s = sketch(); const h = line(s, 0, 0, 10, 2); const v = line(s, 0, 0, 1, 10);
  s.constraints.push(new C.HorizontalConstraint(h.id, h.p1.id, h.p2.id));
  s.constraints.push(new C.VerticalConstraint(v.id, v.p1.id, v.p2.id));
  solved(s);
  assert.ok(near(h.p1.y, h.p2.y)); assert.ok(near(v.p1.x, v.p2.x));
});

test('parallel / perpendicular / collinear', () => {
  const s = sketch();
  const a = line(s, 0, 0, 10, 1), b = line(s, 0, 5, 10, 8), c = line(s, 0, 0, 2, 10), d = line(s, 12, 2, 20, 3);
  s.constraints.push(new C.ParallelConstraint(ref(a), ref(b)));
  s.constraints.push(new C.PerpendicularConstraint(ref(a), ref(c)));
  s.constraints.push(new C.CollinearConstraint(ref(a), ref(d)));
  solved(s);
  assert.ok(near(Math.sin(dir(a) - dir(b)), 0));
  assert.ok(near(Math.cos(dir(a) - dir(c)), 0));
  assert.ok(near(Math.sin(dir(a) - dir(d)), 0));
});

test('equal length and equal radius', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0), b = line(s, 0, 5, 4, 5);
  const c1 = circle(s, 0, 0, 3), c2 = circle(s, 20, 0, 7);
  s.constraints.push(new C.EqualLengthConstraint(ref(a), ref(b)));
  s.constraints.push(new C.EqualRadiusConstraint(c1.id, c2.id));
  solved(s);
  assert.ok(near(len(a), len(b))); assert.ok(near(c1.r, c2.r));
});

test('distance, radius and angle dimensions drive geometry', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0), b = line(s, 0, 0, 5, 5);
  const c = circle(s, 30, 0, 4);
  s.constraints.push(new C.DistanceConstraint(a.p1.id, a.p2.id, 25));
  s.constraints.push(new C.RadiusConstraint(c.id, 12));
  s.constraints.push(new C.CoincidentConstraint(a.p1.id, b.p1.id));
  s.constraints.push(new C.AngleConstraint(ref(a), ref(b), Math.PI / 3));
  solved(s);
  assert.ok(near(len(a), 25)); assert.ok(near(c.r, 12));
  const ang = Math.acos(Math.abs(Math.cos(dir(a) - dir(b))));
  assert.ok(near(ang, Math.PI / 3, 1e-5), `angle ${ang}`);
});

test('driven dimensions do not constrain', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0);
  const d = new C.DistanceConstraint(a.p1.id, a.p2.id, 25); d.driven = true;
  s.constraints.push(d);
  solved(s);
  assert.ok(near(len(a), 10));
});

test('point-line distance, midpoint, point on line / circle', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0);
  const p = point(s, 3, 4), m = point(s, 1, 1), q = point(s, 4, 3);
  const c = circle(s, 20, 0, 5); const r = point(s, 20, 9);
  s.constraints.push(new C.FixConstraint(a.p1.id, 0, 0));
  s.constraints.push(new C.FixConstraint(a.p2.id, 10, 0));
  s.constraints.push(new C.PointLineDistanceConstraint(p.id, ref(a), 7));
  s.constraints.push(new C.MidpointConstraint(m.id, ref(a)));
  s.constraints.push(new C.PointOnLineConstraint(q.id, ref(a)));
  s.constraints.push(new C.PointOnCircleConstraint(r.id, c.id, c.center.id));
  solved(s);
  assert.ok(near(Math.abs(p.y), 7)); assert.ok(near(m.x, 5) && near(m.y, 0));
  assert.ok(near(q.y, 0)); assert.ok(near(Math.hypot(r.x - c.center.x, r.y - c.center.y), c.r));
});

test('point-line distance converges at building scale (metres in mm)', () => {
  // A fixed 1.8 m line and a point that starts 400 mm short of 900 mm away.
  // The residual is in mm, so the solver's absolute tolerance is met.
  const s = sketch(); const a = line(s, 0, 0, 1800, 0);
  const p = point(s, 600, 500);
  s.constraints.push(new C.FixConstraint(a.p1.id, 0, 0));
  s.constraints.push(new C.FixConstraint(a.p2.id, 1800, 0));
  s.constraints.push(new C.PointLineDistanceConstraint(p.id, ref(a), 900));
  const r = solve(s);
  assert.ok(r.residual < 1e-4, `residual ${r.residual}`);
  assert.ok(near(Math.abs(p.y), 900, 1e-4));
});

test('tangency and concentric', () => {
  const s = sketch(); const a = line(s, -10, 0, 10, 0);
  const c = circle(s, 0, 4, 2), c2 = circle(s, 9, 3, 3), c3 = circle(s, 1, 1, 1);
  s.constraints.push(new C.TangentLineCircleConstraint(ref(a), c.id, c.center.id));
  s.constraints.push(new C.TangentCircleCircleConstraint(c.id, c.center.id, c2.id, c2.center.id, false));
  s.constraints.push(new C.ConcentricConstraint(c.center.id, c3.center.id));
  solved(s);
  assert.ok(near(Math.abs(c.center.y - a.p1.y * 0 - (a.p1.y + (a.p2.y - a.p1.y) * ((c.center.x - a.p1.x) / (a.p2.x - a.p1.x)))), c.r, 1e-5));
  assert.ok(near(Math.hypot(c2.center.x - c.center.x, c2.center.y - c.center.y), c.r + c2.r, 1e-5));
  assert.ok(near(c3.center.x, c.center.x) && near(c3.center.y, c.center.y));
});

test('arc endpoint coincident with a line endpoint', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0);
  const ar = arc(s, 10, 6, 5, -Math.PI / 2, 0);
  s.constraints.push(new C.ArcEndpointCoincidentConstraint({ arcId: ar.id, centerId: ar.center.id, which: 'start' }, a.p2.id));
  solved(s);
  ar.syncEnds();
  assert.ok(near(ar.start.x, a.p2.x) && near(ar.start.y, a.p2.y));
});

test('symmetric about an axis', () => {
  const s = sketch(); const axis = line(s, 0, -10, 0, 10);
  const p = point(s, 3, 1), q = point(s, -5, 2);
  s.constraints.push(new C.FixConstraint(axis.p1.id, 0, -10));
  s.constraints.push(new C.FixConstraint(axis.p2.id, 0, 10));
  s.constraints.push(new C.SymmetricConstraint(p.id, q.id, ref(axis)));
  solved(s);
  assert.ok(near(p.x, -q.x) && near(p.y, q.y));
});

test('constraints serialise with their kind', () => {
  const c = new C.DistanceConstraint('e1', 'e2', 4);
  assert.equal(c.toJSON().kind, 'distance');
  assert.equal(c.toJSON().value, 4);
});

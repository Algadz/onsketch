// Scissors: trim to the nearest crossings, split, and what happens to
// relations and dimensions (kept, moved, added at the cut, removed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/src/core/constraints.js';
import { Arc, Circle, Line, Point } from '../../app/src/core/entities.js';
import { findCuts, pieceAt, splitAt, splitSpot, strokeCrossings, trimAt } from '../../app/src/core/trim.js';
import { near, sketch, line, circle, arc, point, solve } from './helpers.js';

const kinds = (s) => s.constraints.map(c => c.kind).sort();
const lines = (s) => s.entities.filter(e => e instanceof Line);

test('cuts: crossings with lines, circles and points lying on the shape, sorted', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  line(s, 3, -1, 3, 1);
  circle(s, 7, 0, 1);
  point(s, 5, 0);
  const cuts = findCuts(s, h);
  assert.deepEqual(cuts.map(c => +c.x.toFixed(6)), [3, 5, 6, 8]);
  assert.ok(cuts[1].point, 'the sketch point is reused');
});

test('trim the middle of a line: two collinear lines, relations stay, the new ends stay on the cutters', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  const v1 = line(s, 3, -2, 3, 2); line(s, 7, -2, 7, 2);
  s.constraints.push(new C.HorizontalConstraint(h.id, h.p1.id, h.p2.id));
  s.constraints.push(new C.FixConstraint(h.p1.id, 0, 0));
  s.constraints.push(new C.DistanceConstraint(h.p1.id, h.p2.id, 10));            // overall length
  s.constraints.push(new C.EqualLengthConstraint({ a: h.p1.id, b: h.p2.id }, { a: v1.p1.id, b: v1.p2.id }));
  const r = trimAt(s, h, { x: 5, y: 0.01 });
  assert.equal(lines(s).length, 4);
  assert.ok(near(h.p2.x, 3) && near(h.p2.y, 0), 'first piece ends on the first cutter');
  const b = r.added[0];
  assert.ok(near(b.p1.x, 7) && near(b.p2.x, 10));
  assert.deepEqual(kinds(s), ['collinear', 'distance', 'fix', 'horizontal', 'pointOnLine', 'pointOnLine']);
  assert.deepEqual(r.dropped.map(c => c.kind), ['equalLength']);
  const hz = s.constraints.find(c => c.kind === 'horizontal');
  assert.equal(hz.p2, h.p2.id, 'horizontal moved to the piece that kept the line');
  assert.ok(solve(s).ok);
});

test('trim an end: the line ends at the cutter, the far relations stay, the cut end ones go', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  line(s, 4, -2, 4, 2);
  s.constraints.push(new C.FixConstraint(h.p1.id, 0, 0));
  s.constraints.push(new C.FixConstraint(h.p2.id, 10, 0));
  s.constraints.push(new C.MidpointConstraint(point(s, 5, 0).id, { a: h.p1.id, b: h.p2.id }));
  trimAt(s, h, { x: 1, y: 0 });
  assert.ok(near(h.p1.x, 4) && near(h.p2.x, 10));
  assert.deepEqual(kinds(s), ['fix', 'pointOnLine']);
  assert.ok(solve(s).ok);
});

test('trim at a T: the cutter\'s end becomes the end (shared point = coincident)', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  const v = line(s, 6, 0, 6, 5);
  s.constraints.push(new C.PointOnLineConstraint(v.p1.id, { a: h.p1.id, b: h.p2.id }));
  trimAt(s, h, { x: 8, y: 0 });
  assert.equal(h.p2, v.p1, 'shared corner');
  assert.equal(s.constraints.length, 0, 'the point-on-line is now the line\'s own end: dropped');
});

test('trim with nothing crossing deletes the shape', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  s.constraints.push(new C.HorizontalConstraint(h.id, h.p1.id, h.p2.id));
  const r = trimAt(s, h, { x: 5, y: 0 });
  assert.ok(r.whole);
  assert.equal(s.entities.length, 0);
  assert.equal(s.constraints.length, 0);
});

test('trim a circle crossed twice: an arc with the circle\'s id, its radius kept, ends on the line', () => {
  const s = sketch();
  const c = circle(s, 0, 0, 5);
  line(s, -10, 3, 10, 3);
  s.constraints.push(new C.RadiusConstraint(c.id, 5));
  s.constraints.push(new C.FixConstraint(c.center.id, 0, 0));
  const r = trimAt(s, c, { x: 0, y: 5 });        // the cap above the line
  const a = s.entities.find(e => e instanceof Arc);
  assert.ok(a && a.id === c.id && r.added[0] === a);
  assert.ok(near(a.start.y, 3) && near(a.end.y, 3), 'ends on the line');
  assert.ok(a.hit({ x: 0, y: -5 }, { zoom: 1 }), 'the bottom stays');
  assert.ok(!a.hit({ x: 0, y: 5 }, { zoom: 1 }), 'the top is gone');
  assert.deepEqual(kinds(s), ['arcEndpointOnLine', 'arcEndpointOnLine', 'fix', 'radius']);
  assert.ok(solve(s).ok);
});

test('trim the middle of an arc: two arcs, same centre, equal radius; end relations follow the end', () => {
  const s = sketch();
  const a = arc(s, 0, 0, 5, 0, Math.PI);
  line(s, 1, -10, 1, 10); line(s, -1, -10, -1, 10);
  const p = point(s, -5, 0);
  s.constraints.push(new C.ArcEndpointCoincidentConstraint({ arcId: a.id, centerId: a.center.id, which: 'end' }, p.id));
  s.constraints.push(new C.RadiusConstraint(a.id, 5));
  const r = trimAt(s, a, { x: 0, y: 5 });
  const b = r.added[0];
  assert.ok(b instanceof Arc && b.center === a.center);
  assert.ok(near(a.end.x, 1) && near(b.start.x, -1) && near(b.end.x, -5));
  const ce = s.constraints.find(c => c.kind === 'arcEndpointCoincident');
  assert.equal(ce.ref.arcId, b.id, 'the end relation moved to the second arc');
  assert.ok(kinds(s).includes('equalRadius'));
  assert.ok(solve(s).ok);
});

test('split a line: two lines sharing the split point, collinear, relations on the first', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  s.constraints.push(new C.HorizontalConstraint(h.id, h.p1.id, h.p2.id));
  const spot = splitSpot(s, h, { x: 4, y: 0.2 });
  const r = splitAt(s, h, spot);
  const b = r.added[0];
  assert.equal(h.p2, b.p1);
  assert.ok(near(h.p2.x, 4));
  assert.deepEqual(kinds(s), ['collinear', 'horizontal']);
  const res = solve(s);
  assert.ok(res.ok);
  assert.equal(res.dof, 4, 'line (3) + one more point along it (1)');
});

test('split snaps to a crossing and keeps the split point on the cutter', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  line(s, 6, -1, 6, 1);
  const spot = splitSpot(s, h, { x: 5.8, y: 0 }, 0.5);
  assert.ok(near(spot.x, 6));
  splitAt(s, h, spot);
  assert.ok(kinds(s).includes('pointOnLine'));
});

test('split an arc and a circle (two points): no redundant relation', () => {
  const s = sketch();
  const a = arc(s, 0, 0, 5, 0, Math.PI);
  s.constraints.push(new C.FixConstraint(a.center.id, 0, 0));
  splitAt(s, a, splitSpot(s, a, { x: 0, y: 5 }));
  assert.equal(s.entities.filter(e => e instanceof Arc).length, 2);
  let r = solve(s);
  assert.ok(r.ok);
  assert.equal(r.redundant, 0);
  assert.equal(r.dof, 4, 'radius, the two outer ends and where the joint is');

  const s2 = sketch();
  const c = circle(s2, 0, 0, 5);
  s2.constraints.push(new C.FixConstraint(c.center.id, 0, 0));
  s2.constraints.push(new C.RadiusConstraint(c.id, 5));
  const out = splitAt(s2, c, splitSpot(s2, c, { x: 5, y: 0 }), splitSpot(s2, c, { x: -5, y: 0 }));
  assert.equal(out.added.length, 2);
  assert.equal(out.added[0].id, c.id);
  r = solve(s2);
  assert.ok(r.ok);
  assert.equal(r.redundant, 0, 'closed loop of two arcs, not over-constrained');
  assert.equal(r.dof, 2, 'where the two joints are on the circle');
});

test('power trim: a stroke finds the shapes it crosses, in order', () => {
  const s = sketch();
  line(s, 2, -5, 2, 5); line(s, 6, -5, 6, 5); circle(s, 20, 0, 1);
  const hits = strokeCrossings(s, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.deepEqual(hits.map(h => h.x), [2, 6]);
});

test('pieceAt: the piece under the cursor between the nearest cuts', () => {
  const s = sketch();
  const h = line(s, 0, 0, 10, 0);
  line(s, 3, -1, 3, 1); line(s, 7, -1, 7, 1);
  const p = pieceAt(s, h, { x: 5, y: 0 });
  assert.ok(near(p.lo.x, 3) && near(p.hi.x, 7));
  const q = pieceAt(s, h, { x: 9, y: 0 });
  assert.ok(near(q.lo.x, 7) && q.hi === null);
  void Circle; void Point;
});

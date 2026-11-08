// Degree-of-freedom bookkeeping: the solver's colour coding
// (under / fully / over constrained) depends on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/src/core/constraints.js';
import { ref, sketch, line, circle, solve } from './helpers.js';

test('a line with only a length dimension has 3 DOF', () => {
  const s = sketch(); line(s, 0, 0, 10, 3);
  s.constraints.push(new C.DistanceConstraint(s.entities[0].p1.id, s.entities[0].p2.id, 10.44));
  const r = solve(s);
  assert.equal(r.dof, 3); assert.equal(r.state, 'under');
});

test('fixed, horizontal, dimensioned line is fully constrained', () => {
  const s = sketch(); const l = line(s, 0, 0, 10, 3);
  s.constraints.push(new C.FixConstraint(l.p1.id, 0, 0));
  s.constraints.push(new C.HorizontalConstraint(l.id, l.p1.id, l.p2.id));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 20));
  const r = solve(s);
  assert.equal(r.dof, 0); assert.equal(r.state, 'fully');
  assert.equal(r.entityStatus.get(l.id), 'fully');
});

test('conflicting dimensions are reported as over-constrained', () => {
  const s = sketch(); const l = line(s, 0, 0, 10, 0);
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 20));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 30));
  const r = solve(s);
  assert.equal(r.state, 'over');
});

test('redundant constraints are flagged', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0), b = line(s, 0, 5, 10, 5);
  s.constraints.push(new C.HorizontalConstraint(a.id, a.p1.id, a.p2.id));
  s.constraints.push(new C.HorizontalConstraint(b.id, b.p1.id, b.p2.id));
  const par = new C.ParallelConstraint(ref(a), ref(b));
  s.constraints.push(par);
  const r = solve(s);
  assert.ok(r.redundantIds.size >= 1);
});

test('independent groups are solved separately and give the same answer', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 2); const c = circle(s, 50, 50, 3);
  s.constraints.push(new C.HorizontalConstraint(a.id, a.p1.id, a.p2.id));
  s.constraints.push(new C.RadiusConstraint(c.id, 8));
  const r = solve(s);
  assert.ok(r.residual < 1e-8);
  assert.equal(r.dof, 3 + 2);
});

test('a constrained rectangle (closed profile) solves to its dimensions', () => {
  const s = sketch();
  const top = line(s, 0, 10, 12, 11), right = line(s, 12, 11, 11, 0), bot = line(s, 11, 0, 1, 1), left = line(s, 1, 1, 0, 10);
  // share corners as the rectangle tool does
  right.p1 = top.p2; bot.p1 = right.p2; left.p1 = bot.p2; left.p2 = top.p1;
  s.constraints.push(new C.HorizontalConstraint(top.id, top.p1.id, top.p2.id));
  s.constraints.push(new C.HorizontalConstraint(bot.id, bot.p1.id, bot.p2.id));
  s.constraints.push(new C.VerticalConstraint(left.id, left.p1.id, left.p2.id));
  s.constraints.push(new C.VerticalConstraint(right.id, right.p1.id, right.p2.id));
  s.constraints.push(new C.FixConstraint(top.p1.id, 0, 10));
  s.constraints.push(new C.DistanceConstraint(top.p1.id, top.p2.id, 40));
  s.constraints.push(new C.DistanceConstraint(right.p1.id, right.p2.id, 25));
  const r = solve(s);
  assert.equal(r.state, 'fully');
  assert.ok(Math.abs(bot.p2.x - 0) < 1e-6 && Math.abs(bot.p2.y + 15) < 1e-6);
});

test('revertOnFailure keeps geometry (fixed points included) when constraints conflict', () => {
  const s = sketch(); const l = line(s, 0, 0, 10, 0);
  s.constraints.push(new C.FixConstraint(l.p1.id, 0, 0));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 10));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 25));     // conflict
  const r = solve(s, { revertOnFailure: true });
  assert.equal(r.state, 'over'); assert.ok(r.reverted);
  assert.deepEqual([l.p1.x, l.p1.y, l.p2.x, l.p2.y], [0, 0, 10, 0]);
});

test('a failing group does not stop an independent group from solving', () => {
  const s = sketch(); const a = line(s, 0, 0, 10, 0); const c = circle(s, 50, 0, 2);
  s.constraints.push(new C.DistanceConstraint(a.p1.id, a.p2.id, 10));
  s.constraints.push(new C.DistanceConstraint(a.p1.id, a.p2.id, 25));
  s.constraints.push(new C.RadiusConstraint(c.id, 7));
  solve(s, { revertOnFailure: true });
  assert.equal(a.p2.x, 10);
  assert.ok(Math.abs(c.r - 7) < 1e-9);
});

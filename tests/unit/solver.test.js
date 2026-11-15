// Degree-of-freedom bookkeeping: the solver's colour coding
// (under / fully / over defined) depends on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/src/core/constraints.js';
import { ref, sketch, line, circle, arc, solve } from './helpers.js';

test('a line with only a length dimension has 3 DOF', () => {
  const s = sketch(); line(s, 0, 0, 10, 3);
  s.constraints.push(new C.DistanceConstraint(s.entities[0].p1.id, s.entities[0].p2.id, 10.44));
  const r = solve(s);
  assert.equal(r.dof, 3); assert.equal(r.state, 'under');
});

test('fixed, horizontal, dimensioned line is fully defined', () => {
  const s = sketch(); const l = line(s, 0, 0, 10, 3);
  s.constraints.push(new C.FixConstraint(l.p1.id, 0, 0));
  s.constraints.push(new C.HorizontalConstraint(l.id, l.p1.id, l.p2.id));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 20));
  const r = solve(s);
  assert.equal(r.dof, 0); assert.equal(r.state, 'fully');
  assert.equal(r.entityStatus.get(l.id), 'fully');
});

test('conflicting dimensions are reported as over-defined', () => {
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

test('an arc has 5 DOF: its endpoints are derived, not free unknowns', () => {
  const s = sketch(); arc(s, 0, 0, 10, 0, Math.PI / 2);
  const r = solve(s);
  assert.equal(r.dof, 5); assert.equal(r.n, 5);
});

test('arc with fixed center and both endpoints fixed is fully defined', () => {
  const s = sketch(); const a = arc(s, 0, 0, 10, 0, Math.PI / 2);
  const end = (which) => ({ arcId: a.id, centerId: a.center.id, which });
  s.constraints.push(new C.FixConstraint(a.center.id, 0, 0));
  s.constraints.push(new C.ArcEndpointFixConstraint(end('start'), 10, 0));
  s.constraints.push(new C.ArcEndpointFixConstraint(end('end'), 0, 10));
  const r = solve(s);
  assert.equal(r.dof, 0); assert.equal(r.state, 'fully');
  assert.equal(r.entityStatus.get(a.id), 'fully');
  assert.equal(r.entityStatus.get(a.start.id), 'fully');
  assert.equal(r.entityStatus.get(a.end.id), 'fully');
});

test('an arc endpoint reads under-defined while its angle is free', () => {
  const s = sketch(); const a = arc(s, 0, 0, 10, 0, Math.PI / 2);
  s.constraints.push(new C.FixConstraint(a.center.id, 0, 0));
  s.constraints.push(new C.ArcEndpointFixConstraint({ arcId: a.id, centerId: a.center.id, which: 'start' }, 10, 0));
  const r = solve(s);
  assert.equal(r.dof, 1);
  assert.equal(r.entityStatus.get(a.start.id), 'fully');
  assert.equal(r.entityStatus.get(a.end.id), 'under');
  assert.equal(r.entityStatus.get(a.id), 'under');
});

test('nullSpaceOf spans the same null space as the row-space route', async () => {
  const { nullSpaceOf, nullSpaceBasis, rowSpaceBasis } = await import('../../app/src/core/math.js');
  // a sparse, rank-deficient 5 × 7 matrix (a redundant row)
  const A = [
    [1, -1, 0, 0, 0, 0, 0],
    [0, 0, 2, 0, -2, 0, 0],
    [1, -1, 0, 0, 0, 0, 0],
    [0, 3, 0, 0, 0, 0, -1],
    [0, 0, 0, 1, 1, 1, 0],
  ];
  const N = nullSpaceOf(A, 7);
  const ref = nullSpaceBasis(rowSpaceBasis(A, 1e-9), 7, 1e-9);
  assert.equal(N.length, ref.length);
  for (const v of N) {
    for (const row of A) assert.ok(Math.abs(row.reduce((s, a, j) => s + a * v[j], 0)) < 1e-12, 'A·v = 0');
    // v lies in span(ref)
    const proj = new Array(7).fill(0);
    for (const b of ref) { const d = b.reduce((s, x, j) => s + x * v[j], 0); for (let j = 0; j < 7; j++) proj[j] += d * b[j]; }
    assert.ok(proj.every((x, j) => Math.abs(x - v[j]) < 1e-9));
  }
  for (let i = 0; i < N.length; i++) for (let k = 0; k < N.length; k++) {
    const d = N[i].reduce((s, x, j) => s + x * N[k][j], 0);
    assert.ok(Math.abs(d - (i === k ? 1 : 0)) < 1e-12, 'orthonormal');
  }
});

test('solveLeastSquares: the wide (dual) and tall (normal) forms agree with the definition', async () => {
  const { solveLeastSquares } = await import('../../app/src/core/math.js');
  const A = [[1, 2, 0, 0], [0, 1, -1, 0]], b = [3, 1];
  const x = solveLeastSquares(A, b, 1e-10);
  assert.ok(Math.abs(x[0] + 2 * x[1] - 3) < 1e-8 && Math.abs(x[1] - x[2] - 1) < 1e-8);
  assert.ok(Math.abs(x[3]) < 1e-12, 'minimum norm: untouched unknowns stay 0');
  const T = [[1, 0], [0, 1], [1, 1]], c = [1, 2, 4];   // least squares: (4/3, 7/3)
  const y = solveLeastSquares(T, c, 1e-12);
  assert.ok(Math.abs(y[0] - 4 / 3) < 1e-9 && Math.abs(y[1] - 7 / 3) < 1e-9);
});

test('redundant constraints: the left-null-space check matches re-ranking without each one', async () => {
  const { rowSpaceBasis } = await import('../../app/src/core/math.js');
  const { numericJacobian } = await import('../../app/src/core/jacobian.js');
  const { Solver } = await import('../../app/src/core/solver.js');
  const s = sketch();
  const a = line(s, 0, 0, 40, 0), b = line(s, 40, 0, 40, 20), c = line(s, 40, 20, 0, 20), d = line(s, 0, 20, 0, 0);
  const cs = [
    new C.CoincidentConstraint(a.p2.id, b.p1.id), new C.CoincidentConstraint(b.p2.id, c.p1.id),
    new C.CoincidentConstraint(c.p2.id, d.p1.id), new C.CoincidentConstraint(d.p2.id, a.p1.id),
    new C.HorizontalConstraint(a.id, a.p1.id, a.p2.id), new C.HorizontalConstraint(c.id, c.p1.id, c.p2.id),
    new C.VerticalConstraint(b.id, b.p1.id, b.p2.id), new C.VerticalConstraint(d.id, d.p1.id, d.p2.id),
    new C.ParallelConstraint(ref(a), ref(c)),                 // implied by the two horizontals
    new C.DistanceConstraint(a.p1.id, a.p2.id, 40), new C.EqualLengthConstraint(ref(a), ref(c)),   // implied by the rectangle
    new C.FixConstraint(a.p1.id, 0, 0),
  ];
  s.constraints.push(...cs);
  const r = new Solver().solve(s, [s], [], { diagnostics: true, componentize: false });
  // brute force on the same Jacobian
  const params = [];
  const seen = new Set();
  for (const e of s.entities) for (const x of [...e.children(), e]) if (!seen.has(x)) { seen.add(x); for (const k of x.paramKeys()) params.push({ ent: x, key: k }); }
  const byId = new Map(); for (const e of s.entities) { byId.set(e.id, e); for (const ch of e.children()) byId.set(ch.id, ch); }
  const L = (id, k) => byId.get(id)?.[k] ?? 0;
  const J = numericJacobian(params, s.constraints, L).J;
  const rank = rowSpaceBasis(J, 1e-7).length;
  const expected = new Set();
  let off = 0;
  for (const c of s.constraints) {
    const rows = c.residuals(L).length;
    const without = J.filter((_, i) => i < off || i >= off + rows);
    if (rowSpaceBasis(without, 1e-7).length >= rank) expected.add(c.id);
    off += rows;
  }
  assert.ok(expected.size >= 2, 'the sketch has redundant constraints');
  assert.deepEqual([...r.redundantIds].sort(), [...expected].sort());
});

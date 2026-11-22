import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointFreedom, traceLocus } from '../../app/src/core/locus.js';

/* A tiny constraint system for the tests: parameters in an array,
   residual functions of them, a numerical Jacobian and Newton
   projection (least squares, normal equations). */
function system(n, values, residuals, point) {
  const v = values.slice();
  const F = () => residuals.flatMap(r => r(v));
  const jac = () => {
    const f0 = F(), J = f0.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const x = v[j], h = 1e-7 * Math.max(1, Math.abs(x)); v[j] = x + h;
      const f1 = F(); v[j] = x;
      for (let i = 0; i < f0.length; i++) J[i][j] = (f1[i] - f0[i]) / h;
    }
    return { J, f: f0, residual: Math.hypot(...f0) };
  };
  const solve = (A, b) => {           // min-norm: x = Aᵀ (A Aᵀ + λI)⁻¹ b
    const m = A.length, M = A.map(r => A.map(q => r.reduce((s, x, k) => s + x * q[k], 0)));
    for (let i = 0; i < m; i++) M[i][i] += 1e-12;
    const y = b.slice();              // Gaussian elimination
    for (let c = 0; c < m; c++) {
      let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]]; [y[c], y[p]] = [y[p], y[c]];
      for (let r = 0; r < m; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let q = c; q < m; q++) M[r][q] -= k * M[c][q]; y[r] -= k * y[c]; }
    }
    const z = y.map((x, i) => x / M[i][i]);
    return new Array(n).fill(0).map((_, j) => A.reduce((s, r, i) => s + r[j] * z[i], 0));
  };
  return {
    n,
    get: () => v.slice(),
    set: (w) => { for (let i = 0; i < n; i++) v[i] = w[i]; },
    jacobian: jac,
    project: () => {
      for (let k = 0; k < 8; k++) {
        const { J, f, residual } = jac();
        if (residual < 1e-12) break;
        const dx = solve(J, f.map(x => -x));
        for (let i = 0; i < n; i++) v[i] += dx[i];
      }
      return jac().residual;
    },
    point: () => point(v),
  };
}
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

test('a point at a fixed distance from a fixed pivot: a closed circle', () => {
  const sys = system(2, [3, 0], [(v) => [dist(v[0], v[1], 0, 0) - 3]], (v) => ({ x: v[0], y: v[1] }));
  const r = traceLocus(sys, { step: 0.2 });
  assert.equal(r.ok, true);
  assert.equal(r.closed, true);
  assert.ok(r.points.every(p => Math.abs(Math.hypot(p.x, p.y) - 3) < 1e-5), 'every point on the circle');
  const len = r.points.slice(1).reduce((s, p, i) => s + dist(p.x, p.y, r.points[i].x, r.points[i].y), 0);
  assert.ok(Math.abs(len - 2 * Math.PI * 3) < 0.05, `once round (${len})`);
  assert.deepEqual(sys.get(), [3, 0], 'geometry put back');
});

test('slider-crank: the slider end travels a segment between its dead points', () => {
  // crank end A (v0, v1) on a circle of radius 1 round the origin, rod
  // A–B of length 3, slider B (v2, v3) on the x axis
  const sys = system(4, [0, 1, Math.sqrt(8), 0], [
    (v) => [dist(v[0], v[1], 0, 0) - 1],
    (v) => [dist(v[0], v[1], v[2], v[3]) - 3],
    (v) => [v[3]],
  ], (v) => ({ x: v[2], y: v[3] }));
  const r = traceLocus(sys, { step: 0.05 });
  assert.equal(r.ok, true);
  assert.equal(r.closed, false);
  const xs = r.points.map(p => p.x);
  assert.ok(Math.min(...xs) < 2.01 && Math.max(...xs) > 3.99, `from 2 to 4 (${Math.min(...xs)}..${Math.max(...xs)})`);
  assert.deepEqual(r.ends, ['locked', 'locked'], 'stops at both dead points');
  // the crank end itself goes all the way round
  const crank = system(4, [0, 1, Math.sqrt(8), 0], [
    (v) => [dist(v[0], v[1], 0, 0) - 1], (v) => [dist(v[0], v[1], v[2], v[3]) - 3], (v) => [v[3]],
  ], (v) => ({ x: v[0], y: v[1] }));
  assert.equal(traceLocus(crank, { step: 0.05 }).closed, true);
});

test('four-bar coupler point: a closed curve, not a circle', () => {
  // ground pivots O1 (0,0), O2 (4,0); crank 1, rocker 3, coupler 3.5;
  // the coupler point P sits 1.5 above the middle of A–B
  const a = 1, b = 3.5, c = 3;
  const A = { x: 0, y: 1 };
  // B: distance b from A and c from O2 (upper solution)
  const dx = 4 - A.x, dy = 0 - A.y, d = Math.hypot(dx, dy), l = (b * b - c * c + d * d) / (2 * d), hgt = Math.sqrt(b * b - l * l);
  const B = { x: A.x + dx * l / d - dy * hgt / d, y: A.y + dy * l / d + dx * hgt / d };
  const s = system(4, [A.x, A.y, B.x, B.y], [
    (v) => [dist(v[0], v[1], 0, 0) - a], (v) => [dist(v[0], v[1], v[2], v[3]) - b], (v) => [dist(v[2], v[3], 4, 0) - c],
  ], (v) => {
    const mx = (v[0] + v[2]) / 2, my = (v[1] + v[3]) / 2, ux = v[2] - v[0], uy = v[3] - v[1], L = Math.hypot(ux, uy);
    return { x: mx - uy / L * 1.5, y: my + ux / L * 1.5 };
  });
  const r = traceLocus(s, { step: 0.05 });
  assert.equal(r.ok, true);
  assert.equal(r.closed, true, `closed (ends ${r.ends})`);
  const rs = r.points.map(p => Math.hypot(p.x - 2, p.y - 2));
  assert.ok(Math.max(...rs) - Math.min(...rs) > 0.1, 'a real coupler curve');
});

test('a fully fixed point has no path; a free point has two degrees of freedom', () => {
  const fixed = system(2, [1, 1], [(v) => [v[0] - 1, v[1] - 1]], (v) => ({ x: v[0], y: v[1] }));
  assert.equal(pointFreedom(fixed, fixed.jacobian().J).dof, 0);
  assert.equal(traceLocus(fixed, { step: 0.1 }).ok, false);
  const free = system(2, [1, 1], [], (v) => ({ x: v[0], y: v[1] }));
  free.jacobian = () => ({ J: [], f: [], residual: 0 });
  assert.equal(pointFreedom(free, []).dof, 2);
});

test('an unbounded path stops at the box', () => {
  // a point on the line y = x, nothing else
  const sys = system(2, [0, 0], [(v) => [v[1] - v[0]]], (v) => ({ x: v[0], y: v[1] }));
  const r = traceLocus(sys, { step: 0.5, bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 } });
  assert.deepEqual(r.ends, ['bounds', 'bounds']);
  assert.ok(r.points.every(p => Math.abs(p.x - p.y) < 1e-6));
});

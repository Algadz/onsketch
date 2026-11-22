import { nullSpaceOf } from './math.js';

/* =============== TRACE PATH (LOCUS OF A POINT) =================
   Where can this point go? With the rest of the sketch free to move as a
   mechanism (fixed points stay put), a point with one degree of freedom
   moves along a curve: a point on a circle round it, the coupler point of
   a crank, the end of a slider. traceLocus() walks that curve.

   At each step: the constraints' free directions (the null space of their
   Jacobian, as dragging uses) give the direction the point can move;
   the geometry takes a small step that way, is pulled back onto the
   constraints, and the point's new position is recorded. The step grows
   on straight stretches and shrinks where the path bends. Both ways from
   the start, until:
     closed   the path comes back to where it started
     locked   the mechanism can't go further (a crank at a dead point,
              a slider at the end of its travel, the solver fails)
     bounds   the point leaves the allowed box (an unbounded path)
     limit    too many steps, too long, or out of time (`deadline`)
   The geometry is put back exactly as it was afterwards (by the caller's
   `set(start)`; traceLocus leaves it at the start values too).

   The system is given by callbacks, so this file knows nothing about
   entities:
     n                  number of parameters
     get() / set(v)     read / write all parameter values
     jacobian()         { J (rows × n), residual } at the current values
     project()          pull the current values back onto the constraints;
                        returns the residual left
     point()            the traced point's position now (after any
                        derived geometry is updated)
   ============================================================ */

const TAU = Math.PI * 2;

/**
 * How the point can move from the current values.
 * @returns {{ dof: 0|1|2, d?: {x,y}, t?: number[] }} for dof 1, the unit
 *   direction d of the point and the parameter step t that moves it by d
 */
export function pointFreedom(sys, J, eps = 1e-6) {
  const K = nullSpaceOf(J, sys.n, 1e-7);
  if (!K.length) return { dof: 0 };
  const v0 = sys.get(), p0 = sys.point();
  const vel = K.map(k => {
    sys.set(v0.map((v, i) => v + eps * k[i]));
    const p = sys.point();
    return { x: (p.x - p0.x) / eps, y: (p.y - p0.y) / eps };
  });
  sys.set(v0);
  // Gram matrix of the point velocities: its rank is the point's freedom.
  let a = 0, b = 0, c = 0;
  for (const v of vel) { a += v.x * v.x; b += v.x * v.y; c += v.y * v.y; }
  const tr = a + c;
  if (tr < 1e-18) return { dof: 0 };
  const disc = Math.sqrt(Math.max(0, (a - c) * (a - c) / 4 + b * b));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  if (l2 > 1e-7 * l1) return { dof: 2 };
  // the main direction (eigenvector of the larger eigenvalue)
  let d = Math.abs(b) > 1e-18 ? { x: b, y: l1 - a } : (a >= c ? { x: 1, y: 0 } : { x: 0, y: 1 });
  const len = Math.hypot(d.x, d.y); d = { x: d.x / len, y: d.y / len };
  const coef = vel.map(v => v.x * d.x + v.y * d.y);
  const s2 = coef.reduce((s, x) => s + x * x, 0);
  const t = new Array(sys.n).fill(0);
  K.forEach((k, j) => { const w = coef[j] / s2; if (w) for (let i = 0; i < sys.n; i++) t[i] += w * k[i]; });
  return { dof: 1, d, t };
}

const inside = (p, b) => !b || (p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY);

/** One way along the path from the current values. */
function walk(sys, sign, o, start) {
  const pts = [];
  let h = o.step, prev = { ...start }, prevD = null, len = 0, far = 0, reason = 'limit';
  for (let n = 0; n < o.maxPoints; n++) {
    if (o.deadline && Date.now() > o.deadline) { reason = 'limit'; break; }
    const { J } = sys.jacobian();
    const f = pointFreedom(sys, J);
    if (f.dof !== 1) { reason = f.dof === 0 ? 'locked' : 'free'; break; }
    let { d, t } = f;
    let s = prevD ? Math.sign(d.x * prevD.x + d.y * prevD.y) || 1 : sign;
    d = { x: d.x * s, y: d.y * s };
    const here = sys.get();
    let ok = false, p = null;
    while (h >= o.minStep) {
      sys.set(here.map((v, i) => v + s * h * t[i]));
      const res = sys.project();
      p = sys.point();
      const mx = p.x - prev.x, my = p.y - prev.y, moved = Math.hypot(mx, my);
      // on the constraints, moved about a step, and the way it was heading
      const cos = moved > 0 ? (mx * d.x + my * d.y) / moved : -1;
      if (res < o.tol && moved > 0.25 * h && moved < 2.5 * h && cos > Math.cos(o.maxTurn)) { ok = true; break; }
      h /= 2;
    }
    if (!ok) { sys.set(here); reason = 'locked'; break; }
    const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
    len += seg;
    pts.push(p);
    prevD = { x: (p.x - prev.x) / seg, y: (p.y - prev.y) / seg };
    // gentle bends: longer steps next time
    const turn = Math.acos(Math.max(-1, Math.min(1, prevD.x * d.x + prevD.y * d.y)));
    if (turn < o.maxTurn / 4) h = Math.min(o.maxStep, h * 1.5);
    prev = p;
    if (!inside(p, o.bounds)) { reason = 'bounds'; break; }
    // back at the start after having gone away from it: a closed path
    const away = Math.hypot(p.x - start.x, p.y - start.y);
    if (far > 2 * h && away <= 1.01 * h) { reason = 'closed'; break; }
    far = Math.max(far, away);
    if (len > o.maxLength) { reason = 'limit'; break; }
  }
  return { pts, reason };
}

/**
 * The path of a point with one degree of freedom.
 * @param {object} sys  callbacks (see the header)
 * @param {object} [opts]
 * @param {number} opts.step       first step length (drawing units)
 * @param {{minX,minY,maxX,maxY}} [opts.bounds]  stop outside this box
 * @param {number} [opts.timeLimit]  ms for the whole trace (both ways)
 * @returns {{ ok: boolean, dof: number, points: {x,y}[], closed: boolean, ends: string[] }}
 *   ends: why each end stopped ('locked' | 'bounds' | 'limit')
 */
export function traceLocus(sys, opts = {}) {
  const step = opts.step > 0 ? opts.step : 1;
  const o = {
    step, minStep: opts.minStep ?? step / 256, maxStep: opts.maxStep ?? step * 4,
    maxPoints: opts.maxPoints ?? 1500, maxLength: opts.maxLength ?? step * 5000,
    maxTurn: opts.maxTurn ?? (TAU / 18), tol: opts.tol ?? 1e-6, bounds: opts.bounds || null,
    deadline: opts.timeLimit ? Date.now() + opts.timeLimit : 0,
  };
  const v0 = sys.get();
  const start = sys.point();
  const { J } = sys.jacobian();
  const f = pointFreedom(sys, J);
  if (f.dof !== 1) { sys.set(v0); return { ok: false, dof: f.dof, points: [start], closed: false, ends: [] }; }
  const fwd = walk(sys, 1, o, start);
  sys.set(v0);
  if (fwd.reason === 'closed') {
    return { ok: true, dof: 1, points: [start, ...fwd.pts.slice(0, -1), start], closed: true, ends: [] };
  }
  const back = walk(sys, -1, o, start);
  sys.set(v0);
  const points = [...back.pts.reverse(), start, ...fwd.pts];
  return { ok: true, dof: 1, points, closed: false, ends: [back.reason, fwd.reason] };
}

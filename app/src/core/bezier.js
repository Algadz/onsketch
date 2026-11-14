/* =============== CUBIC BÉZIER MATH ==============================
   Pure geometry on control points {x, y}: P0 (start), P1 (start
   handle), P2 (end handle), P3 (end). Used by the Bezier entity, its
   relations (point on curve, tangent, smooth), regions, scissors and
   export. No entity imports here.
   ============================================================ */

/** Point at t ∈ [0, 1]. */
export function bezierAt(P, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * P[0].x + b * P[1].x + c * P[2].x + d * P[3].x,
    y: a * P[0].y + b * P[1].y + c * P[2].y + d * P[3].y,
  };
}

/** First derivative at t. */
export function bezierDeriv(P, t) {
  const u = 1 - t, a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  return {
    x: a * (P[1].x - P[0].x) + b * (P[2].x - P[1].x) + c * (P[3].x - P[2].x),
    y: a * (P[1].y - P[0].y) + b * (P[2].y - P[1].y) + c * (P[3].y - P[2].y),
  };
}

/** Second derivative at t. */
export function bezierDeriv2(P, t) {
  const u = 1 - t;
  return {
    x: 6 * u * (P[2].x - 2 * P[1].x + P[0].x) + 6 * t * (P[3].x - 2 * P[2].x + P[1].x),
    y: 6 * u * (P[2].y - 2 * P[1].y + P[0].y) + 6 * t * (P[3].y - 2 * P[2].y + P[1].y),
  };
}

/** Unit tangent at t (falls back to the chord where a handle is zero). */
export function bezierTangent(P, t) {
  let d = bezierDeriv(P, t);
  let L = Math.hypot(d.x, d.y);
  if (L < 1e-12) {
    // zero-length handle at an end: the curve leaves towards the next point
    const e = t < 0.5 ? 1e-4 : 1 - 1e-4;
    d = bezierDeriv(P, e); L = Math.hypot(d.x, d.y);
    if (L < 1e-12) { d = { x: P[3].x - P[0].x, y: P[3].y - P[0].y }; L = Math.hypot(d.x, d.y) || 1; }
  }
  return { x: d.x / L, y: d.y / L };
}

/** De Casteljau: the curve split at t into two cubics covering [0,t] and [t,1]. */
export function bezierSplit(P, t) {
  const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a = lerp(P[0], P[1]), b = lerp(P[1], P[2]), c = lerp(P[2], P[3]);
  const d = lerp(a, b), e = lerp(b, c), f = lerp(d, e);
  return [[{ ...P[0] }, a, d, f], [f, e, c, { ...P[3] }]];
}

/** The piece of the curve between t0 and t1 (t0 < t1), as control points. */
export function bezierSub(P, t0, t1) {
  if (t0 <= 0 && t1 >= 1) return P.map(p => ({ x: p.x, y: p.y }));
  let Q = P;
  if (t1 < 1) Q = bezierSplit(Q, t1)[0];
  if (t0 > 0) Q = bezierSplit(Q, t0 / t1)[1];
  return Q;
}

/** Rough length of the control polygon (an upper bound of the curve's). */
export function polygonLength(P) {
  return Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y) + Math.hypot(P[2].x - P[1].x, P[2].y - P[1].y) + Math.hypot(P[3].x - P[2].x, P[3].y - P[2].y);
}

/** Points along the curve, t evenly spaced; n segments (n + 1 points), each with its t. */
export function bezierSamples(P, n = 48) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = i / n; const p = bezierAt(P, t); p.t = t; out.push(p); }
  return out;
}

/** Number of segments to sample for drawing / regions at a world tolerance. */
export function sampleCount(P, tol = 0.05) {
  const L = polygonLength(P);
  return Math.max(12, Math.min(256, Math.ceil(Math.sqrt(L / Math.max(tol, 1e-9)) * 2)));
}

/** Arc length (Gauss–Legendre, 16 points per half). */
const GL_X = [-0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.7554044083550030, -0.6178762444026438, -0.4580167776572274, -0.2816035507792589, -0.0950125098376374, 0.0950125098376374, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438, 0.7554044083550030, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
const GL_W = [0.0271524594117541, 0.0622535239386479, 0.0951585116824928, 0.1246289712555339, 0.1495959888165767, 0.1691565193950025, 0.1826034150449236, 0.1894506104550685, 0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767, 0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541];
export function bezierLength(P, t0 = 0, t1 = 1) {
  let s = 0;
  const half = (a, b) => {
    const m = (a + b) / 2, h = (b - a) / 2;
    for (let i = 0; i < GL_X.length; i++) { const d = bezierDeriv(P, m + h * GL_X[i]); s += GL_W[i] * h * Math.hypot(d.x, d.y); }
  };
  const mid = (t0 + t1) / 2;
  half(t0, mid); half(mid, t1);
  return s;
}

/**
 * Nearest point of the curve to q: { t, x, y, d }. Coarse samples, then
 * Newton on (B(t) − q)·B'(t) = 0 from the best few, clamped to [0, 1].
 */
export function bezierNearest(P, q, n = 32) {
  let best = null;
  const cands = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = bezierAt(P, t), d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    cands.push({ t, d });
  }
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands.slice(0, 3)) {
    let t = c.t;
    for (let k = 0; k < 12; k++) {
      const p = bezierAt(P, t), d1 = bezierDeriv(P, t), d2 = bezierDeriv2(P, t);
      const fx = p.x - q.x, fy = p.y - q.y;
      const g = fx * d1.x + fy * d1.y;
      const h = d1.x * d1.x + d1.y * d1.y + fx * d2.x + fy * d2.y;
      if (Math.abs(h) < 1e-14) break;
      const nt = Math.max(0, Math.min(1, t - g / h));
      if (Math.abs(nt - t) < 1e-13) { t = nt; break; }
      t = nt;
    }
    const p = bezierAt(P, t), d = Math.hypot(p.x - q.x, p.y - q.y);
    if (!best || d < best.d) best = { t, x: p.x, y: p.y, d };
  }
  return best;
}

/** Bounding box of the curve (from dense samples; tight enough to fit / select). */
export function bezierBBox(P) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of bezierSamples(P, 32)) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/* ---------------- intersections (curve parameter t) ---------------- */

/** Refines a parameter where f(t) changes sign (bisection + secant). */
function refineRoot(f, a, b, fa, fb) {
  for (let i = 0; i < 60; i++) {
    let m = fb !== fa ? b - fb * (b - a) / (fb - fa) : (a + b) / 2;
    if (!(m > a && m < b)) m = (a + b) / 2;
    const fm = f(m);
    if (Math.abs(fm) < 1e-13 || b - a < 1e-14) return m;
    if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else { b = m; fb = fm; }
    if (i % 3 === 2) { const mid = (a + b) / 2, fmid = f(mid); if ((fmid < 0) === (fa < 0)) { a = mid; fa = fmid; } else { b = mid; fb = fmid; } }
  }
  return (a + b) / 2;
}

/** Roots t ∈ [0,1] of a smooth scalar f along the curve (sampled + refined). */
function rootsAlong(f, n = 96) {
  const out = [];
  let tp = 0, fp = f(0);
  if (Math.abs(fp) < 1e-12) out.push(0);
  for (let i = 1; i <= n; i++) {
    const t = i / n, ft = f(t);
    if (Math.abs(ft) < 1e-12) out.push(t);
    else if (fp !== 0 && (ft < 0) !== (fp < 0)) out.push(refineRoot(f, tp, t, fp, ft));
    tp = t; fp = ft;
  }
  return out;
}

/** Where the curve meets the infinite line through a, b: [{ t, x, y }]. */
export function bezierLineHits(P, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  // signed distance is a cubic in t: exact enough with sampling + refine
  const f = (t) => { const p = bezierAt(P, t); return (p.x - a.x) * nx + (p.y - a.y) * ny; };
  return rootsAlong(f).map(t => ({ t, ...bezierAt(P, t) }));
}

/** Where the curve meets the circle (centre c, radius r). */
export function bezierCircleHits(P, c, r) {
  const f = (t) => { const p = bezierAt(P, t); return Math.hypot(p.x - c.x, p.y - c.y) - r; };
  return rootsAlong(f, 128).map(t => ({ t, ...bezierAt(P, t) }));
}

/** Where two curves meet: [{ t (on P), s (on Q), x, y }]. Polyline
 *  crossings refined by Newton on B_P(t) − B_Q(s) = 0. */
export function bezierBezierHits(P, Q) {
  const n = 48;
  const A = bezierSamples(P, n), B = bezierSamples(Q, n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = A[i], p1 = A[i + 1];
    for (let j = 0; j < n; j++) {
      const q0 = B[j], q1 = B[j + 1];
      const rx = p1.x - p0.x, ry = p1.y - p0.y, sx = q1.x - q0.x, sy = q1.y - q0.y;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-18) continue;
      const u = ((q0.x - p0.x) * sy - (q0.y - p0.y) * sx) / den;
      const v = ((q0.x - p0.x) * ry - (q0.y - p0.y) * rx) / den;
      if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) continue;
      let t = p0.t + u / n, s = q0.t + v / n;
      for (let k = 0; k < 20; k++) {
        const a = bezierAt(P, t), b = bezierAt(Q, s), da = bezierDeriv(P, t), db = bezierDeriv(Q, s);
        const fx = a.x - b.x, fy = a.y - b.y;
        const det = -da.x * db.y + da.y * db.x;
        if (Math.abs(det) < 1e-18) break;
        const dt = (-fx * db.y + fy * db.x) / det;
        const ds = (da.x * fy - da.y * fx) / det;
        t = Math.max(0, Math.min(1, t - dt)); s = Math.max(0, Math.min(1, s - ds));
        if (Math.abs(dt) + Math.abs(ds) < 1e-14) break;
      }
      const p = bezierAt(P, t);
      if (!out.some(o => Math.hypot(o.x - p.x, o.y - p.y) < 1e-7)) out.push({ t, s, x: p.x, y: p.y });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/* =============== 1. MATH UTILITIES ============================ */
export const EPS = 1e-9;
export const TAU = Math.PI * 2;
export const dist  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a, b) => (a.x-b.x)**2 + (a.y-b.y)**2;
export const lerp  = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));


/** Solve A x = b where A is square (n×n). Naive Gaussian elimination
 *  with partial pivoting. Returns x or null if singular. */
export function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting on a flat Float64Array.
  // Constraint systems are sparse: rows whose multiplier is 0 are skipped,
  // and each pivot row is swept only over its non-zero columns.
  const n = A.length, w = n + 1;
  const M = new Float64Array(n * w);
  for (let i = 0; i < n; i++) {
    const row = A[i], o = i * w;
    for (let j = 0; j < n; j++) M[o + j] = row[j];
    M[o + n] = b[i];
  }
  const cols = new Int32Array(w);
  for (let i = 0; i < n; i++) {
    let p = i, best = Math.abs(M[i * w + i]);
    for (let k = i + 1; k < n; k++) { const v = Math.abs(M[k * w + i]); if (v > best) { best = v; p = k; } }
    if (best < 1e-14) return null;
    if (p !== i) {
      const oi = i * w, op = p * w;
      for (let j = i; j < w; j++) { const t = M[oi + j]; M[oi + j] = M[op + j]; M[op + j] = t; }
    }
    const oi = i * w, piv = M[oi + i];
    let nc = 0;
    for (let j = i; j < w; j++) if (M[oi + j] !== 0) cols[nc++] = j;
    for (let k = i + 1; k < n; k++) {
      const ok = k * w;
      const a = M[ok + i];
      if (a === 0) continue;
      const f = a / piv;
      for (let c = 0; c < nc; c++) { const j = cols[c]; M[ok + j] -= f * M[oi + j]; }
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const oi = i * w;
    let s = M[oi + n];
    for (let j = i + 1; j < n; j++) { const v = M[oi + j]; if (v !== 0) s -= v * x[j]; }
    x[i] = s / M[oi + i];
  }
  return x;
}

/** Estimate the rank of an m×n matrix by column-pivoted modified
 *  Gram–Schmidt. Returns the count of independent columns whose
 *  residual norm exceeds `tol`. */
export function rankApprox(A, tol = 1e-8) {
  if (!A || !A.length || !A[0].length) return 0;
  const m = A.length, n = A[0].length;
  // Work on column vectors.
  const cols = [];
  for (let j = 0; j < n; j++) {
    const c = new Array(m);
    for (let i = 0; i < m; i++) c[i] = A[i][j];
    cols.push(c);
  }
  const Q = [];
  let rank = 0;
  // Pivot greedily on remaining column with largest norm.
  const remaining = new Set(cols.map((_, i) => i));
  while (remaining.size) {
    let bestIdx = -1, bestN = -1;
    for (const i of remaining) {
      let s = 0; for (let k = 0; k < m; k++) s += cols[i][k] * cols[i][k];
      if (s > bestN) { bestN = s; bestIdx = i; }
    }
    if (bestN < tol * tol) break;
    const v = cols[bestIdx].slice();
    for (const q of Q) {
      let dot = 0;
      for (let k = 0; k < m; k++) dot += v[k] * q[k];
      for (let k = 0; k < m; k++) v[k] -= dot * q[k];
    }
    let norm = 0;
    for (let k = 0; k < m; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm);
    if (norm > tol) {
      for (let k = 0; k < m; k++) v[k] /= norm;
      Q.push(v);
      rank++;
      // strip this component from all remaining columns
      for (const i of remaining) {
        if (i === bestIdx) continue;
        let dot = 0;
        for (let k = 0; k < m; k++) dot += cols[i][k] * v[k];
        for (let k = 0; k < m; k++) cols[i][k] -= dot * v[k];
      }
    }
    remaining.delete(bestIdx);
  }
  return rank;
}

/** Build an orthonormal basis of the row space of m×n matrix A, by
 *  modified Gram-Schmidt on the rows. Returns array of length-n vectors. */
export function rowSpaceBasis(A, tol = 1e-8) {
  if (!A || !A.length) return [];
  const n = A[0].length;
  const basis = [];
  for (let i = 0; i < A.length; i++) {
    const v = A[i].slice();
    for (const b of basis) {
      let dot = 0;
      for (let k = 0; k < n; k++) dot += v[k] * b[k];
      for (let k = 0; k < n; k++) v[k] -= dot * b[k];
    }
    let norm = 0;
    for (let k = 0; k < n; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm);
    if (norm > tol) {
      for (let k = 0; k < n; k++) v[k] /= norm;
      basis.push(v);
    }
  }
  return basis;
}

/** A parameter (column index j) is "pinned" — uniquely determined by the
 *  constraint system — iff the standard basis vector e_j lies in the row
 *  space of J. We check this by ||proj_basis(e_j)||² ≈ 1. */
export function nullSpaceBasis(rowBasis, n, tol = 1e-8) {
  const basis = [];
  for (let j = 0; j < n; j++) {
    const v = new Array(n).fill(0);
    v[j] = 1;
    for (const b of rowBasis) {
      let dot = 0;
      for (let k = 0; k < n; k++) dot += v[k] * b[k];
      for (let k = 0; k < n; k++) v[k] -= dot * b[k];
    }
    for (const b of basis) {
      let dot = 0;
      for (let k = 0; k < n; k++) dot += v[k] * b[k];
      for (let k = 0; k < n; k++) v[k] -= dot * b[k];
    }
    let norm = 0;
    for (let k = 0; k < n; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm);
    if (norm > tol) {
      for (let k = 0; k < n; k++) v[k] /= norm;
      basis.push(v);
    }
  }
  return basis;
}

/** Orthonormal basis of the null space of A (m × n): the directions
 *  that keep A·x unchanged. Row reduction with partial pivoting, skipping
 *  zeros (constraint Jacobians are sparse): each column without a pivot
 *  gives one null vector, and only those few are orthonormalised. Much
 *  cheaper than a row-space basis followed by projecting every unit
 *  vector (n³), with the same subspace.
 *  @returns {Float64Array[]} */
export function nullSpaceOf(A, n, tol = 1e-7) {
  const m = A.length;
  const R = [];
  for (let i = 0; i < m; i++) R.push(Float64Array.from(A[i]));
  const pivotCol = [];                    // pivot column of each reduced row
  const isPivot = new Uint8Array(n);
  let r = 0;
  for (let c = 0; c < n && r < m; c++) {
    let p = -1, best = tol;
    for (let i = r; i < m; i++) { const v = Math.abs(R[i][c]); if (v > best) { best = v; p = i; } }
    if (p < 0) continue;                  // no pivot: a free column
    if (p !== r) { const t = R[p]; R[p] = R[r]; R[r] = t; }
    const pr = R[r], inv = 1 / pr[c];
    for (let j = c; j < n; j++) if (pr[j] !== 0) pr[j] *= inv;
    const nz = [];
    for (let j = c; j < n; j++) if (pr[j] !== 0) nz.push(j);
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const row = R[i], f = row[c];
      if (f === 0) continue;
      for (const j of nz) row[j] -= f * pr[j];
      row[c] = 0;
    }
    pivotCol.push(c); isPivot[c] = 1; r++;
  }
  // x_free = e_f, x_pivot = −(reduced row)[f]
  const vecs = [];
  for (let f = 0; f < n; f++) {
    if (isPivot[f]) continue;
    const v = new Float64Array(n);
    v[f] = 1;
    for (let k = 0; k < pivotCol.length; k++) { const a = R[k][f]; if (a !== 0) v[pivotCol[k]] = -a; }
    vecs.push(v);
  }
  // orthonormalise (modified Gram–Schmidt, twice for accuracy)
  const basis = [];
  for (const v of vecs) {
    for (let pass = 0; pass < 2; pass++) {
      for (const b of basis) {
        let d = 0;
        for (let k = 0; k < n; k++) d += v[k] * b[k];
        if (d !== 0) for (let k = 0; k < n; k++) v[k] -= d * b[k];
      }
    }
    let norm = 0;
    for (let k = 0; k < n; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) { for (let k = 0; k < n; k++) v[k] /= norm; basis.push(v); }
  }
  return basis;
}

export function solveLeastSquares(A, b, damping = 1e-8) {
  if (!A.length || !A[0]?.length) return null;
  const m = A.length, n = A[0].length;
  // Sparse rows: constraint Jacobians are mostly zeros.
  const nz = A.map(row => { const out = []; for (let j = 0; j < n; j++) if (row[j] !== 0) out.push(j); return out; });
  if (m < n) {
    // Fewer equations than unknowns: the same damped least-squares step
    // through the smaller m × m system, x = Aᵀ (A Aᵀ + λI)⁻¹ b
    // (identical to (AᵀA + λI)⁻¹ Aᵀ b; the minimum-norm move).
    const G = Array.from({ length: m }, () => new Array(m).fill(0));
    for (let i = 0; i < m; i++) {
      const ri = A[i];
      for (let k = i; k < m; k++) {
        const rk = A[k];
        let s = 0;
        const a = nz[i], c = nz[k];
        if (a.length <= c.length) { for (const j of a) s += ri[j] * rk[j]; }
        else { for (const j of c) s += ri[j] * rk[j]; }
        G[i][k] = s; G[k][i] = s;
      }
      G[i][i] += damping;
    }
    const y = solveLinear(G, b.slice());
    if (!y) return null;
    const x = new Array(n).fill(0);
    for (let i = 0; i < m; i++) { const yi = y[i]; if (yi === 0) continue; for (const j of nz[i]) x[j] += A[i][j] * yi; }
    return x;
  }
  const normal = Array.from({ length:n }, () => new Array(n).fill(0));
  const rhs = new Array(n).fill(0);
  for (let i = 0; i < m; i++) {
    const row = A[i], cols = nz[i];
    for (const j of cols) {
      const aij = row[j];
      rhs[j] += aij * b[i];
      const out = normal[j];
      for (const k of cols) out[k] += aij * row[k];
    }
  }
  for (let j = 0; j < n; j++) normal[j][j] += damping;
  return solveLinear(normal, rhs);
}

export function paramPinnedFromBasis(basis, n) {
  const pinned = new Array(n).fill(false);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (const b of basis) s += b[j] * b[j];
    pinned[j] = s > 1 - 1e-6;
  }
  return pinned;
}

/** Intersection of two infinite lines (a,b) and (c,d). null if parallel. */
export function lineIntersection(a, b, c, d) {
  const denom = (a.x-b.x)*(c.y-d.y) - (a.y-b.y)*(c.x-d.x);
  if (Math.abs(denom) < EPS) return null;
  const t = ((a.x-c.x)*(c.y-d.y) - (a.y-c.y)*(c.x-d.x)) / denom;
  return { x: a.x + t*(b.x-a.x), y: a.y + t*(b.y-a.y) };
}

export function normAngle(a) {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

export function ccwDelta(from, to) {
  return normAngle(to - from);
}

export function signedAngleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

export function unwrapAngleNear(angle, reference) {
  return reference + signedAngleDelta(reference, angle);
}

export function angleOnDirectedArc(theta, a0, a1, clockwise = false, tol = 1e-3) {
  const span = clockwise ? normAngle(a0 - a1) : normAngle(a1 - a0);
  const rel = clockwise ? normAngle(a0 - theta) : normAngle(theta - a0);
  return rel <= span + tol;
}

export function directedArcSpan(a0, a1, clockwise = false) {
  return clockwise ? -normAngle(a0 - a1) : normAngle(a1 - a0);
}

export function drawDirectedArcPath(ctx, view, center, radius, a0, a1, clockwise = false) {
  const span = directedArcSpan(a0, a1, clockwise);
  if (Math.abs(span) < 1e-6 || radius < EPS) return;
  const steps = Math.max(8, Math.ceil(Math.abs(span) / (Math.PI / 24)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + span * t;
    const p = view.worldToScreen({
      x: center.x + radius * Math.cos(a),
      y: center.y + radius * Math.sin(a)
    });
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
}

export function angleSeparation(a, b) {
  const d = ccwDelta(a, b);
  return d > Math.PI ? TAU - d : d;
}

export function normalizeAngleValue(rad) {
  if (!Number.isFinite(rad)) return 0;
  let a = Math.abs(rad) % TAU;
  if (a > Math.PI) a = TAU - a;
  return a;
}

export function angleArcFromPoints(a1, b1, a2, b2) {
  const ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
  const ang2 = Math.atan2(b2.y - a2.y, b2.x - a2.x);
  const d12 = ccwDelta(ang1, ang2);
  if (d12 <= Math.PI) {
    return { start: ang1, end: ang1 + d12, span: d12, midAngle: normAngle(ang1 + d12 / 2) };
  }
  const span = TAU - d12;
  return { start: ang2, end: ang2 + span, span, midAngle: normAngle(ang2 + span / 2) };
}

export function angleSectorCandidates(l1, l2) {
  const a1 = Math.atan2(l1.p2.y - l1.p1.y, l1.p2.x - l1.p1.x);
  const a2 = Math.atan2(l2.p2.y - l2.p1.y, l2.p2.x - l2.p1.x);
  const rays = [
    { line: 1, angle: normAngle(a1),           ref: { a:l1.p1.id, b:l1.p2.id } },
    { line: 1, angle: normAngle(a1 + Math.PI), ref: { a:l1.p2.id, b:l1.p1.id } },
    { line: 2, angle: normAngle(a2),           ref: { a:l2.p1.id, b:l2.p2.id } },
    { line: 2, angle: normAngle(a2 + Math.PI), ref: { a:l2.p2.id, b:l2.p1.id } }
  ].sort((a, b) => a.angle - b.angle);

  const out = [];
  for (let i = 0; i < rays.length; i++) {
    const start = rays[i];
    const end = rays[(i + 1) % rays.length];
    if (start.line === end.line) continue;
    const span = ccwDelta(start.angle, end.angle);
    if (span < 1e-7 || span > Math.PI + 1e-7) continue;
    out.push({
      start: start.angle,
      end: start.angle + span,
      span,
      value: normalizeAngleValue(span),
      midAngle: normAngle(start.angle + span / 2),
      l1Ref: start.line === 1 ? start.ref : end.ref,
      l2Ref: start.line === 2 ? start.ref : end.ref
    });
  }
  return out;
}

export function angleSectorForCursor(l1, l2, world) {
  const inter = lineIntersection(l1.p1, l1.p2, l2.p1, l2.p2);
  if (!inter) return null;
  const candidates = angleSectorCandidates(l1, l2);
  if (!candidates.length) return null;
  if (!world) return candidates.reduce((best, c) => c.span < best.span ? c : best, candidates[0]);

  if (dist(inter, world) < EPS) {
    return candidates.reduce((best, c) => c.span < best.span ? c : best, candidates[0]);
  }

  const bearing = normAngle(Math.atan2(world.y - inter.y, world.x - inter.x));
  let best = null;
  for (const c of candidates) {
    const within = ccwDelta(c.start, bearing) <= c.span + 1e-7;
    if (!within) continue;
    const score = angleSeparation(bearing, c.midAngle);
    if (!best || score < best.score) best = { ...c, score };
  }
  if (best) {
    const { score, ...sector } = best;
    return sector;
  }

  const fallback = candidates
    .map(c => ({ ...c, score: angleSeparation(bearing, c.midAngle) }))
    .sort((a, b) => a.score - b.score)[0];
  const { score, ...sector } = fallback;
  return sector;
}

export function angleSectorForValue(l1, l2, value, preferredMidAngle = null) {
  const candidates = angleSectorCandidates(l1, l2);
  if (!candidates.length) return null;
  const target = normalizeAngleValue(value);
  return candidates
    .map(c => ({
      ...c,
      valueScore: Math.abs(c.value - target),
      midScore: preferredMidAngle == null ? 0 : angleSeparation(c.midAngle, preferredMidAngle)
    }))
    .sort((a, b) => {
      const dv = a.valueScore - b.valueScore;
      if (Math.abs(dv) > 1e-7) return dv;
      return a.midScore - b.midScore;
    })[0];
}

export function regularPolygonFromCenterEdge(center, edgeMid, sides) {
  const n = Math.max(3, Math.round(sides || 6));
  const apothem = dist(center, edgeMid);
  if (apothem < EPS) return null;
  const theta = Math.atan2(edgeMid.y - center.y, edgeMid.x - center.x);
  const radius = apothem / Math.cos(Math.PI / n);
  const start = theta - Math.PI / n;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = start + i * TAU / n;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}

export function centerRectangleCorners(center, corner) {
  const dx = corner.x - center.x;
  const dy = corner.y - center.y;
  if (Math.abs(dx) < EPS || Math.abs(dy) < EPS) return null;
  return {
    a: { x: center.x - dx, y: center.y - dy },
    b: { x: center.x + dx, y: center.y - dy },
    c: { x: center.x + dx, y: center.y + dy },
    d: { x: center.x - dx, y: center.y + dy }
  };
}

export function circleFrom3Points(a, b, c) {
  const ax=a.x, ay=a.y, bx=b.x, by=b.y, cx=c.x, cy=c.y;
  const d = 2*(ax*(by-cy) + bx*(cy-ay) + cx*(ay-by));
  if (Math.abs(d) < EPS) return null;
  const ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / d;
  const uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / d;
  return { center: { x: ux, y: uy }, r: Math.hypot(ax-ux, ay-uy) };
}

export function mirrorPointAcrossLine(p, axis) {
  const ax = axis.p1.x, ay = axis.p1.y;
  const dx = axis.p2.x - axis.p1.x, dy = axis.p2.y - axis.p1.y;
  const len2 = dx*dx + dy*dy;
  if (len2 < EPS) return { x:p.x, y:p.y };
  const t = ((p.x - ax)*dx + (p.y - ay)*dy) / len2;
  const hx = ax + t*dx, hy = ay + t*dy;
  return { x: 2*hx - p.x, y: 2*hy - p.y };
}

export function offsetLine(line, signedDistance) {
  const dx = line.p2.x - line.p1.x;
  const dy = line.p2.y - line.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  const nx = -dy / len, ny = dx / len;
  return {
    p1: { x: line.p1.x + nx * signedDistance, y: line.p1.y + ny * signedDistance },
    p2: { x: line.p2.x + nx * signedDistance, y: line.p2.y + ny * signedDistance }
  };
}

export function offsetCircle(circle, signedDistance) {
  const r = circle.r + signedDistance;
  if (r <= EPS) return null;
  return { center: { x: circle.center.x, y: circle.center.y }, r };
}

export function offsetArc(arc, signedDistance) {
  const r = arc.r + signedDistance;
  if (r <= EPS) return null;
  return { center: { x: arc.center.x, y: arc.center.y }, r, a0: arc.a0, a1: arc.a1, clockwise: !!arc.clockwise };
}

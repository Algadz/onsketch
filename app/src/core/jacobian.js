/* =============== SPARSE NUMERICAL JACOBIAN =====================
   The solver and the drag code differentiate the constraint residuals
   numerically: nudge one parameter, see how the residuals change. Done
   naively, every nudge re-evaluates every constraint: n parameters × m
   constraints. In a real sketch each parameter appears in only a few
   constraints (a corner's x is read by its lines' relations, not by the
   other 100), so that was ~50× more work than needed: a 59-line enclosure
   took half a second per drag frame.

   Here each constraint is evaluated once with a recording lookup to learn
   which entities it actually reads (its refs() are added for safety), and
   a nudge then re-evaluates only the constraints that read that
   parameter's entity. If a constraint's residual count changes from one
   evaluation to the next, the whole Jacobian falls back to the full
   computation, so the result is always the same as the naive one.
   ============================================================ */

/**
 * @param {{ent, key}[]} params   parameters, in column order (ent.id is used)
 * @param {object[]} constraints  with residuals(L) and refs()
 * @param {(id, key) => number} L lookup
 */
export function buildJacobianPlan(params, constraints, L) {
  const offsets = [], counts = [];
  const f = [];
  const reads = [];
  for (const c of constraints) {
    const ids = new Set();
    for (const id of c.refs ? c.refs() : []) if (id) ids.add(id);
    const spy = (id, key) => { ids.add(id); return L(id, key); };
    const r = c.residuals(spy);
    offsets.push(f.length);
    counts.push(r.length);
    for (const v of r) f.push(v);
    reads.push(ids);
  }
  const byId = new Map();
  constraints.forEach((c, i) => { for (const id of reads[i]) { if (!byId.has(id)) byId.set(id, []); byId.get(id).push(i); } });
  const deps = params.map(p => byId.get(p.ent.id) || []);
  return { constraints, offsets, counts, deps, m: f.length };
}

function fullF(constraints, L) {
  const f = [];
  for (const c of constraints) for (const v of c.residuals(L)) f.push(v);
  return f;
}

/**
 * Residuals and Jacobian (dense rows, m × n) at the current values.
 * @returns {{ f:number[], J:number[][], residual:number }}
 */
export function numericJacobian(params, constraints, L, plan = null) {
  const n = params.length;
  plan = plan && plan.constraints === constraints && plan.deps.length === n ? plan : buildJacobianPlan(params, constraints, L);
  // residuals now, per constraint
  const f = [];
  let sparse = true;
  for (let i = 0; i < constraints.length; i++) {
    const r = constraints[i].residuals(L);
    if (r.length !== plan.counts[i]) sparse = false;
    for (const v of r) f.push(v);
  }
  const m = f.length;
  const J = Array.from({ length: m }, () => new Array(n).fill(0));
  if (sparse) {
    for (let j = 0; j < n; j++) {
      const p = params[j];
      const x0 = p.ent[p.key];
      const step = Math.max(1e-6, Math.abs(x0) * 1e-7);
      const inv = 1 / step;
      p.ent[p.key] = x0 + step;
      let bad = false;
      for (const ci of plan.deps[j]) {
        const r = constraints[ci].residuals(L);
        if (r.length !== plan.counts[ci]) { bad = true; break; }
        const o = plan.offsets[ci];
        for (let k = 0; k < r.length; k++) J[o + k][j] = (r[k] - f[o + k]) * inv;
      }
      p.ent[p.key] = x0;
      if (bad) { sparse = false; break; }
    }
  }
  if (!sparse) {                                   // the naive way, always right
    for (const row of J) row.fill(0);
    for (let j = 0; j < n; j++) {
      const p = params[j];
      const x0 = p.ent[p.key];
      const step = Math.max(1e-6, Math.abs(x0) * 1e-7);
      p.ent[p.key] = x0 + step;
      const fp = fullF(constraints, L);
      p.ent[p.key] = x0;
      const inv = 1 / step;
      for (let i = 0; i < m && i < fp.length; i++) J[i][j] = (fp[i] - f[i]) * inv;
    }
  }
  return { f, J, residual: Math.sqrt(f.reduce((s, v) => s + v * v, 0)) };
}

/** Column indices of the non-zero entries of each row. */
export function rowNonZeros(J) {
  return J.map(row => { const nz = []; for (let j = 0; j < row.length; j++) if (row[j] !== 0) nz.push(j); return nz; });
}

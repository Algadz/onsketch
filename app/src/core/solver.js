import { paramPinnedFromBasis, rowSpaceBasis, solveLinear } from './math.js';

/* =============== 4. SOLVER ==================================== */
export class Solver {
  constructor() { this.maxIter = 80; this.tol = 1e-9; this.lambda0 = 1e-3; }

  /** Build the param vector + an id-to-entity lookup. The lookup
   *  scope is `lookupScope` (entities visible across the project),
   *  but only entities in `editScope` (the active sketch) provide
   *  parameters that the solver actually moves. */
  _collectParams(editScope) {
    const params = [];
    const seen = new Set();
    const walk = (e) => {
      if (seen.has(e)) return;
      seen.add(e);
      for (const c of e.children()) walk(c);
      if (e.locked) return;   // locked geometry is constant (see Project.syncLocks)
      for (const k of e.paramKeys()) params.push({ ent: e, key: k });
    };
    for (const e of editScope.entities) walk(e);
    return params;
  }

  _lookupBuilder(allSketches) {
    const byId = new Map();
    const walk = (e) => { byId.set(e.id, e); for (const c of e.children()) walk(c); };
    for (const s of allSketches) for (const e of s.entities) walk(e);
    return (id, key) => {
      const e = byId.get(id);
      return e ? e[key] : 0;
    };
  }

  _componentGroups(activeSketch, constraints) {
    const graph = new Map();
    const add = (id) => {
      if (!id) return;
      if (!graph.has(id)) graph.set(id, new Set());
    };
    const link = (a, b) => {
      if (!a || !b || a === b) return;
      add(a); add(b);
      graph.get(a).add(b);
      graph.get(b).add(a);
    };
    const walk = (e) => {
      add(e.id);
      for (const child of e.children()) {
        add(child.id);
        link(e.id, child.id);
        walk(child);
      }
    };
    for (const e of activeSketch.entities) walk(e);
    for (const c of constraints) {
      if (c.driven) continue;
      const refs = c.refs().filter(Boolean);
      for (const id of refs) add(id);
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) link(refs[i], refs[j]);
      }
    }

    const seen = new Set();
    const groups = [];
    for (const e of activeSketch.entities) {
      if (seen.has(e.id)) continue;
      const ids = new Set();
      const q = [e.id];
      seen.add(e.id);
      ids.add(e.id);
      for (let qi = 0; qi < q.length; qi++) {
        const id = q[qi];
        for (const nb of (graph.get(id) || [])) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          ids.add(nb);
          q.push(nb);
        }
      }
      const entities = activeSketch.entities.filter(ent => {
        if (ids.has(ent.id)) return true;
        return ent.children().some(child => ids.has(child.id));
      });
      const groupConstraints = constraints.filter(c => c.refs().some(id => ids.has(id)));
      groups.push({ ids, entities, constraints:groupConstraints });
    }
    return groups;
  }

  _solveComponents(activeSketch, allVisibleSketches, constraints, options) {
    const groups = this._componentGroups(activeSketch, constraints);
    if (groups.length <= 1) {
      return this.solve({ entities:activeSketch.entities, constraints }, allVisibleSketches, [], { ...options, componentize:false });
    }
    const activeIds = options.activeIds instanceof Set
      ? options.activeIds
      : (options.activeIds ? new Set(options.activeIds) : null);
    const groupsToSolve = activeIds && activeIds.size
      ? groups.filter(g => [...activeIds].some(id => g.ids.has(id)))
      : groups;
    if (!groupsToSolve.length) {
      const diagnostics = options.diagnostics !== false;
      return {
        ok:true, iters:0, residual:0, dof:diagnostics ? 0 : null,
        n:0, m:0, rank:diagnostics ? 0 : null, redundant:0,
        state:diagnostics ? 'under' : 'solved',
        entityStatus:diagnostics ? new Map() : null,
        redundantIds:diagnostics ? new Set() : null,
        pinned:diagnostics ? [] : null, diagnostics
      };
    }

    const diagnostics = options.diagnostics !== false;
    const entityStatus = diagnostics ? new Map() : null;
    const redundantIds = diagnostics ? new Set() : null;
    const pinned = [];
    let ok = true, iters = 0, residualSq = 0, n = 0, m = 0, rank = 0, redundant = 0, dof = 0;
    let over = false, under = false;

    for (const group of groupsToSolve) {
      const subSketch = { entities: group.entities, constraints: group.constraints };
      const r = this.solve(subSketch, allVisibleSketches, [], { ...options, componentize:false });
      ok = ok && r.ok;
      iters = Math.max(iters, r.iters || 0);
      residualSq += (r.residual || 0) * (r.residual || 0);
      n += r.n || 0;
      m += r.m || 0;
      if (diagnostics) {
        rank += r.rank || 0;
        redundant += r.redundant || 0;
        dof += r.dof || 0;
        if (r.state === 'over') over = true;
        else if (r.state === 'under') under = true;
        for (const [id, status] of r.entityStatus || []) entityStatus.set(id, status);
        for (const id of r.redundantIds || []) redundantIds.add(id);
        if (r.pinned) pinned.push(...r.pinned);
      } else if (r.state === 'over') {
        over = true;
      }
    }

    const residual = Math.sqrt(residualSq);
    const state = diagnostics
      ? (over ? 'over' : (under || dof > 0 ? 'under' : 'fully'))
      : (over || residual > 1e-3 ? 'over' : 'solved');
    return {
      ok, iters, residual, dof:diagnostics ? dof : null, n, m,
      rank:diagnostics ? rank : null, redundant, state,
      entityStatus, redundantIds, pinned:diagnostics ? pinned : null, diagnostics
    };
  }

  solve(activeSketch, allVisibleSketches = [activeSketch], extraConstraints = [], options = {}) {
    const diagnostics = options.diagnostics !== false;
    if (activeSketch.project) activeSketch.project.syncLocks();
    const constraints = extraConstraints.length
      ? activeSketch.constraints.concat(extraConstraints)
      : activeSketch.constraints;
    if (options.componentize !== false && activeSketch.entities?.length > 1) {
      return this._solveComponents(activeSketch, allVisibleSketches, constraints, options);
    }
    const params = this._collectParams(activeSketch);
    const n = params.length;

    if (n === 0) return { ok:true, iters:0, residual:0, dof:diagnostics ? 0 : null, n:0, m:constraints.length,
                          rank:diagnostics ? 0 : null, redundant:0, state:diagnostics ? 'fully' : 'solved',
                          entityStatus:diagnostics ? new Map() : null,
                          redundantIds:diagnostics ? new Set() : null,
                          pinned:diagnostics ? [] : null, diagnostics };
    if (constraints.length === 0) {
      return { ok:true, iters:0, residual:0, dof:diagnostics ? n : null, n, m:0,
               rank:diagnostics ? 0 : null, redundant:0, state:diagnostics ? 'under' : 'solved',
               entityStatus:diagnostics ? new Map() : null,
               redundantIds:diagnostics ? new Set() : null,
               pinned:diagnostics ? new Array(n).fill(false) : null, diagnostics };
    }

    const L = this._lookupBuilder(allVisibleSketches);
    const x = params.map(p => p.ent[p.key]);
    const setX = (xv) => { for (let i = 0; i < n; i++) params[i].ent[params[i].key] = xv[i]; };
    setX(x);

    const computeF = () => {
      const f = [];
      for (const c of constraints) for (const r of c.residuals(L)) f.push(r);
      return f;
    };

    let f = computeF();
    let m = f.length;
    let lambda = this.lambda0;
    let lastJ = null;

    let iters;
    for (iters = 0; iters < this.maxIter; iters++) {
      // numerical Jacobian
      const J = Array.from({ length: m }, () => new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        const x0 = x[j];
        const step = Math.max(1e-6, Math.abs(x0) * 1e-7);
        x[j] = x0 + step; setX(x);
        const fp = computeF();
        x[j] = x0; setX(x);
        const inv = 1.0 / step;
        for (let i = 0; i < m; i++) J[i][j] = (fp[i] - f[i]) * inv;
      }
      lastJ = J;

      const sumSq = f.reduce((s, v) => s + v*v, 0);
      if (Math.sqrt(sumSq) < this.tol) { iters++; break; }

      const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
      const Jtf = new Array(n).fill(0);
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
          const Jij = J[i][j]; if (Jij === 0) continue;
          Jtf[j] += Jij * f[i];
          for (let k = 0; k < n; k++) JtJ[j][k] += Jij * J[i][k];
        }
      }
      for (let j = 0; j < n; j++) JtJ[j][j] += lambda;

      const dx = solveLinear(JtJ, Jtf.map(v => -v));
      if (!dx) { lambda *= 10; if (lambda > 1e12) break; continue; }

      for (let j = 0; j < n; j++) x[j] += dx[j];
      setX(x);
      const f2 = computeF();
      const sumSq2 = f2.reduce((s, v) => s + v*v, 0);
      if (sumSq2 < sumSq) {
        f = f2;
        lambda = Math.max(1e-9, lambda * 0.5);
      } else {
        for (let j = 0; j < n; j++) x[j] -= dx[j];
        setX(x);
        lambda *= 4;
        if (lambda > 1e12) break;
      }
    }

    const residual = Math.sqrt(f.reduce((s,v)=>s+v*v, 0));
    if (!diagnostics) {
      const state = residual > 1e-3 ? 'over' : 'solved';
      return { ok: residual < 1e-4, iters, residual, dof:null, n, m, rank:null,
               redundant:0, state, entityStatus:null, redundantIds:null, pinned:null,
               diagnostics:false };
    }

    // Rank-based analysis of the final Jacobian. The orthonormal basis
    // of J's row space lets us answer two questions cheaply:
    //   1) Is parameter j fully determined?  → projection of e_j onto
    //      the basis has unit length.
    //   2) Which constraints are redundant?  → rerun rank with each
    //      constraint's rows removed; if rank doesn't drop, redundant.
    const basis = lastJ ? rowSpaceBasis(lastJ, 1e-7) : [];
    const rank = basis.length;
    const dof = Math.max(0, n - rank);
    const redundant = Math.max(0, m - rank);
    const pinned = paramPinnedFromBasis(basis, n);

    // Per-entity status: gather param indices recursively (own + children),
    // then "fully" iff every relevant parameter is pinned.
    const entToIdx = new Map();
    for (let i = 0; i < params.length; i++) {
      const e = params[i].ent;
      if (!entToIdx.has(e)) entToIdx.set(e, []);
      entToIdx.get(e).push(i);
    }
    const gather = (e, acc) => {
      const own = entToIdx.get(e); if (own) for (const i of own) acc.push(i);
      for (const c of e.children()) gather(c, acc);
    };
    const entityStatus = new Map();
    const setStatus = (e) => {
      const idx = []; gather(e, idx);
      // No free parameters (locked, or every point shared with locked
      // geometry) reads as fully defined.
      const fully = idx.every(i => pinned[i]);
      entityStatus.set(e.id, fully ? 'fully' : 'under');
    };
    for (const e of activeSketch.entities) {
      setStatus(e);
      for (const c of e.children()) setStatus(c);
    }

    // Per-constraint redundancy: a constraint is redundant if removing its
    // rows from J leaves the rank unchanged. We compute row offsets while
    // walking constraints in their original order.
    const redundantIds = new Set();
    if (lastJ && rank > 0 && constraints.length > 1) {
      let off = 0;
      for (const c of constraints) {
        const rows = c.residuals(L).length;
        if (rows === 0) continue;
        const Jminus = [];
        for (let i = 0; i < lastJ.length; i++) {
          if (i < off || i >= off + rows) Jminus.push(lastJ[i]);
        }
        const rWithout = rowSpaceBasis(Jminus, 1e-7).length;
        if (rWithout >= rank) redundantIds.add(c.id);
        off += rows;
      }
    }

    let state;
    if (residual > 1e-3) state = 'over';
    else if (dof === 0)  state = 'fully';
    else                  state = 'under';

    return { ok: residual < 1e-4, iters, residual, dof, n, m, rank, redundant,
             state, entityStatus, redundantIds, pinned };
  }
}

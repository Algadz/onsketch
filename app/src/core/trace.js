import { Arc, Point } from './entities.js';
import { markTangentContacts } from './constraints.js';
import { buildJacobianPlan, numericJacobian } from './jacobian.js';
import { solveLeastSquares, EPS } from './math.js';
import { simplifyPoints } from './strokes.js';
import { traceLocus } from './locus.js';

/* =============== TRACED PATH OF A POINT: THE SHARED PART ==========
   What a point's path depends on, and the path itself, without the
   editor: the editor (app/locus.js) and the sketch format (core/spec.js,
   the AI's "trace" items) use the same mechanism and the same
   fingerprint, so a path traced by one is up to date for the other.

     pathComponent(project, sketch, point)  the shapes tied to the point
        through constraints (the mechanism that moves it) and those
        constraints
     pathFingerprint(point, comp)  a short hash of what defines that
        mechanism (stored as traces.fp; a different hash = out of date)
     tracePointPath(project, sketch, point)  traces it (core/locus.js),
        puts the geometry back, and returns the ink points with the
        traces record, or why it can't
   ============================================================ */

/** Shapes linked to `point` through constraints, and those constraints. */
export function pathComponent(project, sketch, point) {
  const byId = new Map();
  const walk = (e) => { byId.set(e.id, e); for (const c of e.children()) walk(c); };
  for (const s of project.sketches) for (const e of s.entities) walk(e);
  const ownerOf = (id) => { const e = byId.get(id); return e ? (project.ownerOf(e) || e) : null; };
  const ids = (e) => [e.id, ...(e.children ? e.children().map(c => c.id) : [])];
  const start = project.ownerOf(point) || point;
  const ents = new Set([start]), seen = new Set(), cons = new Set();
  const byRef = new Map();
  for (const c of sketch.constraints) {
    if (c.driven) continue;
    for (const id of c.refs()) { if (!byRef.has(id)) byRef.set(id, []); byRef.get(id).push(c); }
  }
  const queue = [start];
  while (queue.length) {
    const e = queue.pop();
    for (const id of ids(e)) {
      if (seen.has(id)) continue;
      seen.add(id);
      for (const c of byRef.get(id) || []) {
        if (cons.has(c)) continue;
        cons.add(c);
        for (const r of c.refs()) {
          const o = ownerOf(r);
          if (o && !ents.has(o)) { ents.add(o); queue.push(o); }
        }
      }
    }
  }
  return { entities: [...ents], constraints: [...cons] };
}

/** A short hash of what defines the point's mechanism: its shapes, the
 *  relations and dimensions among them (values, equations, fixed
 *  positions), and where held geometry sits. Positions the mechanism can
 *  move through are left out: dragging along the path doesn't change it. */
export function pathFingerprint(point, comp) {
  if (!comp) return '';
  let h = 2166136261;
  const mix = (s) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); };
  const num = (v) => mix(Number.isFinite(v) ? String(Number(v.toPrecision(7))) : String(v));
  const ents = [...comp.entities].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of ents) for (const x of [e, ...e.children()]) {
    mix(x.id);
    if (x.locked) { mix('L'); for (const k of x.paramKeys()) num(x[k]); }   // held: its place matters
  }
  const cons = [...comp.constraints].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const c of cons) {
    const o = c.toJSON ? c.toJSON() : { kind: c.kind };
    for (const k of Object.keys(o).sort()) {
      if (/^label|^layerId$|^name$/.test(k)) continue;           // where a label sits, what it's called
      const v = o[k];
      mix(k);
      if (typeof v === 'number') num(v); else mix(JSON.stringify(v));
    }
  }
  return 'v2:' + (h >>> 0).toString(36) + ':' + cons.length;
}

/** Size of the sketch around `point`: a first step, and the box an
 *  endless path stops at (`minSize`: the editor's few pixels). */
export function pathScale(sketch, point, minSize = 0) {
  let x0 = point.x, y0 = point.y, x1 = point.x, y1 = point.y;
  for (const e of sketch.entities) for (const p of [e, ...e.children()]) {
    if (p instanceof Point) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    if (e.r > 0 && p === e) { x0 = Math.min(x0, e.center.x - e.r); x1 = Math.max(x1, e.center.x + e.r); y0 = Math.min(y0, e.center.y - e.r); y1 = Math.max(y1, e.center.y + e.r); }
  }
  const size = Math.max(x1 - x0, y1 - y0, 1e-6 * Math.max(1, Math.abs(point.x) + Math.abs(point.y)), minSize);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { size, bounds: { minX: cx - size, maxX: cx + size, minY: cy - size, maxY: cy + size } };
}

/** Message for a point that can't be traced. */
export function untraceableMessage(dof) {
  return dof === 0
    ? 'This point can\'t move: the sketch holds it in place, so its path is just the point.'
    : 'This point can move freely in two directions, so its positions cover an area, not a path. Add a constraint or fix a point of the mechanism, then trace again.';
}

/**
 * Traces the path of `point` without the editor. The geometry is put back.
 * @returns {{ ok: true, points, traces } | { ok: false, message }}
 */
export function tracePointPath(project, sketch, point, { timeLimit = 4000 } = {}) {
  const comp = pathComponent(project, sketch, point);
  project.syncLocks?.();
  const rows = [];
  const seenE = new Set();
  const walk = (e) => {
    if (seenE.has(e)) return; seenE.add(e);
    for (const c of e.children()) walk(c);
    if (e.locked) return;
    for (const key of e.paramKeys()) rows.push({ ent: e, id: e.id, key, value: e[key] });
  };
  for (const e of comp.entities) walk(e);
  if (!rows.length) return { ok: false, message: 'This point is fixed: it has no path to trace.' };
  const byId = new Map();
  const w2 = (e) => { byId.set(e.id, e); for (const c of e.children()) w2(c); };
  for (const s of project.sketches) for (const e of s.entities) w2(e);
  const L = (id, key) => { const e = byId.get(id); return e ? e[key] : 0; };
  const active = comp.constraints.filter(c => !c.driven);
  markTangentContacts(active, L);
  const plan = buildJacobianPlan(rows, active, L);
  const arcs = comp.entities.filter(e => e instanceof Arc);
  const sync = () => { for (const a of arcs) a.syncEnds(); };
  const get = () => rows.map(r => r.ent[r.key]);
  const set = (v) => { for (let i = 0; i < rows.length; i++) rows[i].ent[rows[i].key] = v[i]; sync(); };
  const system = () => numericJacobian(rows, active, L, plan);
  const sys = {
    n: rows.length, get, set,
    jacobian: system,
    project: () => {
      let s = system();
      for (let pass = 0; pass < 8; pass++) {
        if (s.residual < 1e-7 || !s.J.length) break;
        const step = solveLeastSquares(s.J, s.f.map(v => -v), 1e-6);
        if (!step) break;
        const before = get();
        for (let i = 0; i < rows.length; i++) {
          let v = rows[i].ent[rows[i].key] + step[i];
          if (rows[i].key === 'r') v = Math.max(EPS, v);
          rows[i].ent[rows[i].key] = v;
        }
        const next = system();
        if (next.residual <= s.residual) { s = next; continue; }
        set(before);
        break;
      }
      sync();
      return s.residual;
    },
    point: () => ({ x: point.x, y: point.y }),
  };
  const { size, bounds } = pathScale(sketch, point);
  const before = get();
  let result;
  try { result = traceLocus(sys, { step: size / 160, maxStep: size / 40, bounds, timeLimit }); }
  finally { set(before); }
  if (!result.ok) return { ok: false, message: untraceableMessage(result.dof) };
  const pts = simplifyPoints(result.points, size * 2e-4).map(p => ({ x: p.x, y: p.y }));
  return { ok: true, points: pts, traces: { point: point.id, fp: pathFingerprint(point, comp), tol: size * 2e-3, closed: result.closed, ends: result.ends } };
}

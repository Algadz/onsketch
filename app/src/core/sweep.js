import { Arc } from './entities.js';
import { Solver } from './solver.js';
import { evaluate } from './expr.js';
import { allDimensions, internalValue, solveEquations, userValue, measureDrivenDimensions } from './equations.js';
import { placePatternCopies, patternCopyCount, syncPattern, PATTERN_MAX_COPIES } from './patterns.js';

/* =============== A SKETCH AT OTHER VALUES ========================
   Set variables, re-apply the equations (dimensions and pattern
   formulas) and solve, as the editor does when a slider moves; or sweep
   one variable over a range, solving step by step from the previous
   position (the way a slider is dragged), to see a mechanism move. The
   sketch is always put back as it was. Used by the sketch format's swept
   traces and by the MCP server's check_sketch.
   ============================================================ */

/** Every parameter's value and every variable's formula, to put back. */
export function snapshotSketch(project) {
  const sketch = project.active();
  const params = [], seen = new Set();
  const walk = (e) => { if (seen.has(e)) return; seen.add(e); for (const k of e.paramKeys()) params.push([e, k, e[k]]); for (const c of e.children()) walk(c); };
  for (const e of sketch.entities) walk(e);
  return {
    params,
    vars: (project.variables || []).map(v => [v, v.expr]),
    dims: allDimensions(project).map(c => [c, c.value, c.pairs ? c.pairs.map(p => p.value) : null]),
    entities: sketch.entities.slice(),
    constraints: sketch.constraints.slice(),
    patterns: sketch.constraints.filter(c => c.kind === 'pattern').map(c => [c, JSON.stringify(c.params), JSON.stringify(c.instances)]),
  };
}
export function restoreSketch(project, snap) {
  const sketch = project.active();
  sketch.entities = snap.entities.slice();
  sketch.constraints = snap.constraints.slice();
  for (const [c, params, inst] of snap.patterns) { c.params = JSON.parse(params); c.instances = JSON.parse(inst); }
  for (const [e, k, v] of snap.params) e[k] = v;
  for (const [v, expr] of snap.vars) v.expr = expr;
  for (const [c, value, pairs] of snap.dims) { c.value = value; if (pairs) c.pairs.forEach((p, i) => { p.value = pairs[i]; }); }
  for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
}

/** Re-applies variables and formulas to the dimensions and patterns.
 *  @returns {string[]} problems (formula errors) */
export function applyEquations(project) {
  const problems = [];
  solveEquations(project, (c, v) => {
    if (c.kind === 'offsetDistance') { c.value = Math.abs(v); for (const p of c.pairs) p.value = (p.value < 0 ? -1 : 1) * Math.abs(v); }
    else c.value = internalValue(c, v);
  });
  const values = new Map();
  for (const v of project.variables || []) {
    if (v.error) problems.push(`${v.name}: ${v.error}`);
    else values.set(v.name, v.value);
    delete v.value; delete v.error;
  }
  for (const c of allDimensions(project)) {
    if (c.exprError) problems.push(`${c.name}: ${c.exprError}`);
    if (c.name && c.value != null) values.set(c.name, userValue(c));
    delete c.exprError;
  }
  const sketch = project.active();
  for (const c of sketch.constraints) {
    if (c.kind !== 'pattern' || !c.params.exprs) continue;
    let structural = false;
    for (const [path, expr] of Object.entries(c.params.exprs)) {
      let v;
      try { v = evaluate(expr, (n) => values.get(n)); } catch (e) { problems.push(`pattern ${path}: ${e.message}`); continue; }
      const [a, b] = path.split('.');
      const target = b ? c.params[a] : c.params, key = b || a;
      if (/count/.test(key)) { v = Math.max(1, Math.round(v)); if (v !== target[key]) structural = true; }
      target[key] = v;
    }
    if (structural && patternCopyCount(c.type, c.params) <= PATTERN_MAX_COPIES) syncPattern(sketch, c);
    placePatternCopies(sketch, c);
  }
  return problems;
}

/** Solves the sketch as it is now. @returns {{ ok, residual, state, dof, result }} */
export function solveNow(project) {
  const sketch = project.active();
  const r = new Solver().solve(sketch, [sketch], [], { diagnostics: true });
  for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
  measureDrivenDimensions(sketch);
  const ok = r.ok && r.residual <= 1e-6 && !(r.collapsed?.size);
  return { ok, residual: r.residual, state: r.state, dof: r.dof, result: r };
}

/** Sets variables to numbers (they must exist). */
export function setVariables(project, values) {
  const problems = [];
  for (const [name, value] of Object.entries(values || {})) {
    const v = (project.variables || []).find(x => x.name === name);
    if (!v) { problems.push(`no variable "${name}"`); continue; }
    if (!Number.isFinite(value)) { problems.push(`"${name}" needs a number`); continue; }
    v.expr = String(value);
  }
  return problems;
}

/** The values a sweep visits: `steps` + 1 values from `from` to `to`. */
export function sweepValues(from, to, steps) {
  const n = Math.max(1, Math.min(400, Math.round(steps)));
  return Array.from({ length: n + 1 }, (_, i) => from + (to - from) * i / n);
}

/**
 * Moves `variable` from its current value to `from`, then to `to` in
 * `steps`, solving at each value from the previous position, calling
 * visit(value, { ok, state }) at each value of the range. Stops at the
 * first value that can't be solved. The sketch is put back afterwards.
 * @returns {{ ok: boolean, failedAt: number|null, visited: number }}
 */
export function sweepVariable(project, { variable, from, to, steps = 40 }, visit) {
  const snap = snapshotSketch(project);
  const v = (project.variables || []).find(x => x.name === variable);
  if (!v) return { ok: false, failedAt: null, visited: 0, problem: `no variable "${variable}"` };
  const start = Number(v.expr);
  let out = { ok: true, failedAt: null, visited: 0 };
  try {
    // walk to the start of the range from where the sketch is
    if (Number.isFinite(start) && Math.abs(start - from) > 1e-12) {
      for (const x of sweepValues(start, from, Math.min(60, Math.max(4, steps)))) {
        v.expr = String(x); applyEquations(project);
        if (!solveNow(project).ok) { out = { ok: false, failedAt: x, visited: 0 }; return out; }
      }
    }
    for (const x of sweepValues(from, to, steps)) {
      v.expr = String(x);
      const problems = applyEquations(project);
      const s = problems.length ? { ok: false, state: 'error' } : solveNow(project);
      if (!s.ok) { out = { ok: false, failedAt: x, visited: out.visited }; return out; }
      out.visited++;
      visit?.(x, s);
    }
    return out;
  } finally {
    restoreSketch(project, snap);
  }
}

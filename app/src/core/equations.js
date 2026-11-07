/* =============== EQUATIONS =====================================
   SolidWorks-style equations. Every driving dimension gets a name
   (D1, D2, …). A dimension may carry an expression (`c.expr`) that
   refers to other dimensions and to global variables
   (`project.variables`: { name, expr }). Before each solve the
   equations are evaluated in dependency order and the results written
   into the dimension values; cycles and bad names are reported per
   dimension / variable instead of applied.

   Values seen by equations are what the user sees: lengths in mm,
   angles in degrees, diameter dimensions as diameters.
   ============================================================ */
import { evaluate, NAME_RE, isReservedName } from './expr.js';
import { normalizeAngleValue } from './math.js';

export const DIM_KINDS = new Set(['distance', 'pointLineDistance', 'radius', 'curveDistance', 'angle', 'directedAngle', 'offsetDistance']);
export const isDimension = (c) => !!c && DIM_KINDS.has(c.kind);
export const isAngular = (c) => c.kind === 'angle' || c.kind === 'directedAngle';

/** The number the user sees and types for a dimension. */
export function userValue(c) {
  if (c.value == null) return null;
  if (c.kind === 'angle') return normalizeAngleValue(c.value) * 180 / Math.PI;
  if (c.kind === 'directedAngle') return c.value * 180 / Math.PI;
  if (c.kind === 'radius' && c.isDiameter) return c.value * 2;
  return c.value;
}

/** Internal value for a user value (inverse of userValue). */
export function internalValue(c, v) {
  if (c.kind === 'angle') return normalizeAngleValue(v * Math.PI / 180);
  if (c.kind === 'directedAngle') return v * Math.PI / 180;
  if (c.kind === 'radius' && c.isDiameter) return v / 2;
  return v;
}

export function allDimensions(project) {
  const out = [];
  for (const s of project.sketches) for (const c of s.constraints) if (isDimension(c)) out.push(c);
  return out;
}

/** Give every dimension without a name the next free Dn. */
export function ensureDimensionNames(project) {
  const dims = allDimensions(project);
  const used = new Set(dims.map(c => c.name).filter(Boolean));
  for (const v of project.variables || []) used.add(v.name);
  let n = 1;
  for (const c of dims) {
    if (c.name) continue;
    while (used.has('D' + n)) n++;
    c.name = 'D' + n;
    used.add(c.name);
  }
}

/** Is `name` usable for a new variable / renamed dimension? */
export function validateName(project, name, self = null) {
  if (!NAME_RE.test(name)) return 'Use letters, digits and _, starting with a letter';
  if (isReservedName(name)) return `"${name}" is reserved`;
  const taken = allDimensions(project).some(c => c !== self && c.name === name)
    || (project.variables || []).some(v => v !== self && v.name === name);
  return taken ? `"${name}" is already used` : null;
}

/** Replace whole-word `from` with `to` in every expression. */
export function renameReferences(project, from, to) {
  const re = new RegExp(`\\b${from}\\b`, 'g');
  for (const c of allDimensions(project)) if (c.expr) c.expr = c.expr.replace(re, to);
  for (const v of project.variables || []) if (v.expr) v.expr = v.expr.replace(re, to);
}

/**
 * Evaluate all variables and dimension equations.
 * @param {(c, userValue:number) => void} apply  writes a dimension value
 * @returns {number} how many errors were found
 */
export function solveEquations(project, apply) {
  const dims = allDimensions(project);
  const vars = project.variables || [];
  const byName = new Map();
  for (const v of vars) byName.set(v.name, { v });
  for (const c of dims) if (c.name) byName.set(c.name, { c });

  const memo = new Map();
  const visiting = new Set();
  const value = (name) => {
    if (memo.has(name)) return memo.get(name);
    const node = byName.get(name);
    if (!node) return undefined;
    if (visiting.has(name)) throw new Error(`Circular reference through ${name}`);
    visiting.add(name);
    try {
      let val;
      if (node.v) val = evaluate(node.v.expr, value);
      else if (node.c.expr && !node.c.driven) val = evaluate(node.c.expr, value);
      else val = userValue(node.c);
      memo.set(name, val);
      return val;
    } finally {
      visiting.delete(name);
    }
  };

  let errors = 0;
  for (const v of vars) {
    try { v.value = value(v.name); v.error = null; }
    catch (e) { v.error = e.message; errors++; }
  }
  for (const c of dims) {
    if (!c.expr || c.driven) { c.exprError = null; continue; }
    try {
      const val = value(c.name);
      if (!isAngular(c) && !(val > 0)) throw new Error('Must be greater than 0');
      c.exprError = null;
      if (Math.abs(val - userValue(c)) > 1e-12) apply(c, val);
    } catch (e) { c.exprError = e.message; errors++; }
  }
  return errors;
}

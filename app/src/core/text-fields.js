import { evaluate } from './expr.js';
import { allDimensions, userValue } from './equations.js';

/* =============== FORMULAS IN TEXT ==============================
   A text can show values computed from the drawing: anything between
   braces is an expression, evaluated like an equation, with the
   dimensions (D1, D2…) and the global variables.

     Orbit {orbit} km            →  Orbit 20300 km
     Speed {sqrt(360000/orbit)}  →  Speed 4.21
     Ø {D2:3}                    →  Ø 20.300     (":3" = three decimals)
     {{literal braces}}          →  {literal braces}

   Values are in the document unit (lengths) or degrees (angles), as in
   the Equations window. Without ":n" a value shows up to two decimals,
   trailing zeros dropped. A field that can't be computed shows "#?"
   (Properties and the editor show the text as typed, with its formulas).
   The text keeps its formulas: the shown values follow every change.
   ============================================================ */

const FIELD = /\{\{|\}\}|\{([^{}]*)\}/g;

export function hasFields(text) {
  return typeof text === 'string' && text.includes('{');
}

/** Number as a field shows it. */
export function formatFieldValue(v, digits = null) {
  if (digits != null) return v.toFixed(digits);
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/** name → value lookup over a project's variables and dimensions (values
 *  as the user sees them). Variables are evaluated on demand, so it works
 *  on a project just loaded (thumbnails, the library). */
export function projectLookup(project) {
  const vars = new Map((project.variables || []).map(v => [v.name, v]));
  const dims = new Map();
  for (const c of allDimensions(project)) if (c.name) dims.set(c.name, c);
  const memo = new Map(), busy = new Set();
  const look = (name) => {
    if (memo.has(name)) return memo.get(name);
    let val;
    const v = vars.get(name);
    if (v) {
      if (Number.isFinite(v.value)) val = v.value;
      else if (!busy.has(name)) {
        busy.add(name);
        try { val = evaluate(v.expr, look); } catch { val = undefined; } finally { busy.delete(name); }
      }
    } else if (dims.has(name)) {
      val = userValue(dims.get(name));
    }
    memo.set(name, val);
    return val;
  };
  return look;
}

/**
 * The text with each {expr} replaced by its value.
 * @param {string} text
 * @param {(name:string)=>number|undefined} lookup
 * @returns {{ text:string, errors:string[] }}
 */
export function resolveFields(text, lookup) {
  const errors = [];
  if (!hasFields(text)) return { text, errors };
  const out = text.replace(FIELD, (m, body) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    let src = body.trim(), digits = null;
    const d = /:\s*(\d{1,2})\s*$/.exec(src);
    if (d) { digits = Math.min(12, +d[1]); src = src.slice(0, d.index).trim(); }
    if (!src) return m;
    try { return formatFieldValue(evaluate(src.replace(/^=\s*/, ''), lookup), digits); }
    catch (e) { errors.push(`{${body}}: ${e.message}`); return '#?'; }
  });
  return { text: out, errors };
}

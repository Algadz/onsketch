/* =============== COMPARE TWO VERSIONS ===========================
   What changed between an earlier version of a drawing and the drawing
   now (the History window's Compare). Shapes, ink and dimensions keep
   their ids from one save to the next, so they are matched by id:
     removed  in the old version only;
     added    in the current drawing only;
     changed  in both, but moved, resized or restyled.
   Dimensions compare their values (and formulas); global variables
   compare their formulas. Nothing here touches the DOM.
   ============================================================ */
import { isDimension, isAngular, userValue } from './equations.js';
import { strokeToJSON } from './strokes.js';

/** Same JSON, numbers rounded (solver noise isn't a change). */
function signature(o) {
  return JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : (k === 'selected' || k === 'hover' ? undefined : v)));
}

/** Matches two lists by id: { removed, added, changed: [[old, now]] }. */
function matchById(oldList, newList, sig) {
  const before = new Map(oldList.map(x => [x.id, x]));
  const after = new Map(newList.map(x => [x.id, x]));
  const out = { removed: [], added: [], changed: [] };
  for (const [id, o] of before) {
    const n = after.get(id);
    if (!n) out.removed.push(o);
    else if (sig(o) !== sig(n)) out.changed.push([o, n]);
  }
  for (const [id, n] of after) if (!before.has(id)) out.added.push(n);
  return out;
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/**
 * @param {import('./model.js').Project} before  the earlier version
 * @param {import('./model.js').Project} now     the drawing now
 * @returns {{
 *   shapes: { removed: object[], added: object[], changed: Array<[object, object]> },
 *   ink:    { removed: object[], added: object[], changed: Array<[object, object]> },
 *   dims:   Array<{ name: string, from: number|null, to: number|null, angular: boolean, fromExpr: string|null, toExpr: string|null }>,
 *   vars:   Array<{ name: string, from: string|null, to: string|null }>,
 *   same: boolean }}
 */
export function compareProjects(before, now) {
  const all = (p, pick) => p.sketches.flatMap(pick);
  const shapes = matchById(all(before, s => s.entities), all(now, s => s.entities), e => signature(e.toJSON()));
  const ink = matchById(all(before, s => s.strokes || []), all(now, s => s.strokes || []), st => signature(strokeToJSON(st)));

  const dimsOf = (p) => all(p, s => s.constraints.filter(isDimension));
  const d = matchById(dimsOf(before), dimsOf(now), c => `${round(userValue(c) ?? NaN)}|${c.expr || ''}|${c.name || ''}`);
  const dim = (o, n) => ({
    name: (n || o).name || '',
    from: o ? userValue(o) : null, to: n ? userValue(n) : null,
    angular: isAngular(n || o),
    fromExpr: o?.expr || null, toExpr: n?.expr || null,
  });
  const dims = [
    ...d.changed.map(([o, n]) => dim(o, n)),
    ...d.added.map(n => dim(null, n)),
    ...d.removed.map(o => dim(o, null)),
  ].filter(x => x.from == null || x.to == null || round(x.from) !== round(x.to) || x.fromExpr !== x.toExpr)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const vb = new Map((before.variables || []).map(v => [v.name, v.expr]));
  const vn = new Map((now.variables || []).map(v => [v.name, v.expr]));
  const vars = [];
  for (const [name, expr] of vn) if (vb.get(name) !== expr) vars.push({ name, from: vb.has(name) ? vb.get(name) : null, to: expr });
  for (const [name, expr] of vb) if (!vn.has(name)) vars.push({ name, from: expr, to: null });

  const n = (x) => x.removed.length + x.added.length + x.changed.length;
  return { shapes, ink, dims, vars, same: !n(shapes) && !n(ink) && !dims.length && !vars.length };
}

/** "2 shapes added, 1 removed, 3 changed": a short summary of a part. */
export function countText(part, noun) {
  const bits = [];
  if (part.added.length) bits.push(`${part.added.length} added`);
  if (part.removed.length) bits.push(`${part.removed.length} removed`);
  if (part.changed.length) bits.push(`${part.changed.length} changed`);
  return bits.length ? `${noun}: ${bits.join(', ')}` : '';
}

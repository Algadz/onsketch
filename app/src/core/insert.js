import { newId } from './entities.js';
import { Project } from './model.js';

/* =============== INSERT A SKETCH INTO ANOTHER ===================
   A saved sketch (yours, or one from the library) placed inside the
   open one as a part at real size: a connector, a standard component,
   a piece of furniture. Everything comes along: shapes with their
   relations and dimensions, fills, ink, text, pictures, patterns.

   What happens to it on the way in:
   - Every id is renewed, so nothing collides with the open drawing.
   - Its layers arrive as new layers on top, named after the sketch
     ("USB-C socket", or "USB-C socket: Pads" when it has several), so
     the part can be hidden, locked, restyled or deleted as a whole and
     its fills keep the areas they were painted in.
   - It is moved so its middle lands on `at`.
   - What pinned it to the page is dropped (Fix relations: a part saved
     at the origin would otherwise be stuck there). Its own relations and
     dimensions stay, so it keeps its shape and can be dragged or
     dimensioned against the drawing around it.
   - Dimension names (D1…) and variables that are already taken get a
     new name, and the part's equations are rewritten to match.

   Works on the saved form (JSON), so every reference is covered
   whatever relation holds it, patterns included.
   ============================================================ */

/** Keys whose strings are words for people, never references. */
const WORDS = new Set(['text', 'name', 'expr', 'kind', 'type', 'color', 'image', 'units', 'lineStyle', 'head', 'tips', 'description', 'background', 'key']);
const PINS = new Set(['fix', 'arcEndpointFix']);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fin = Number.isFinite;

function collectIds(v, ids) {
  if (Array.isArray(v)) { for (const x of v) collectIds(x, ids); return; }
  if (!isObj(v)) return;
  if (typeof v.id === 'string') ids.add(v.id);
  if (typeof v.group === 'string') ids.add(v.group);
  for (const [k, x] of Object.entries(v)) if (k !== 'images') collectIds(x, ids);
}

function remap(v, map, key = '') {
  if (typeof v === 'string') return !WORDS.has(key) && map.has(v) ? map.get(v) : v;
  if (Array.isArray(v)) return v.map(x => remap(x, map, key));
  if (!isObj(v)) return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) o[map.has(k) ? map.get(k) : k] = remap(x, map, k);
  return o;
}

/** Renames identifiers in a formula: "D1*2 + gap" with D1 → D4. */
export function renameInFormula(expr, names) {
  if (typeof expr !== 'string' || !names.size) return expr;
  return expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (id) => names.get(id) || id);
}
function renameFormulas(v, names, key = '') {
  if (typeof v === 'string') return key === 'expr' ? renameInFormula(v, names) : v;
  if (Array.isArray(v)) return v.map(x => renameFormulas(x, names, key));
  if (!isObj(v)) return v;
  const o = {};
  // Pattern parameters keep their formulas in `exprs: { count: '…' }`.
  for (const [k, x] of Object.entries(v)) o[k] = k === 'exprs' && isObj(x) ? Object.fromEntries(Object.entries(x).map(([n, e]) => [n, renameInFormula(e, names)])) : renameFormulas(x, names, k);
  return o;
}

/** Every saved coordinate of a sketch, visited so it can be read or moved. */
function eachPoint(sj, fn) {
  const walkEntity = (v) => {
    if (Array.isArray(v)) { v.forEach(walkEntity); return; }
    if (!isObj(v)) return;
    if (fin(v.x) && fin(v.y)) fn(v, 'x', 'y', fin(v.r) ? v.r : 0);
    else if (fin(v.r) && isObj(v.center) && fin(v.center.x)) fn(v.center, 'x', 'y', v.r, true);
    for (const x of Object.values(v)) walkEntity(x);
  };
  walkEntity(sj.entities || []);
  // Fixed spots inside relations (a pattern's frozen centre or target).
  const walkRel = (v) => {
    if (Array.isArray(v)) { v.forEach(walkRel); return; }
    if (!isObj(v)) return;
    if (fin(v.x) && fin(v.y)) fn(v, 'x', 'y', 0, false, true);
    for (const x of Object.values(v)) walkRel(x);
  };
  walkRel(sj.constraints || []);
  for (const f of sj.fills || []) if (isObj(f.seed)) fn(f.seed, 'x', 'y', 0, false, true);
  for (const s of sj.strokes || []) {
    if (Array.isArray(s.pts)) for (let i = 0; i + 1 < s.pts.length; i += 2) fn(s.pts, i, i + 1, 0);
    if (s.link && Array.isArray(s.link.f)) fn(s.link.f, 0, 1, 0, false, true);
  }
}

function nextFree(base, used, start = 1) {
  for (let n = start; ; n++) { const name = base + n; if (!used.has(name)) return name; }
}

/**
 * Inserts the sketch saved as `sourceJSON` into `target` (a Project).
 * @param {{x:number,y:number}|null} at   where its middle goes (world); null keeps its own position
 * @param {string} name                   what to call it (layer names); defaults to the saved name
 * @returns {{ entityIds, strokeIds, layerIds, name, pinsDropped, bounds } | null} null when there is nothing in it
 */
export function insertProject(target, sourceJSON, { at = null, name = null } = {}) {
  const base = target.active();
  if (!base) return null;
  // Canonical saved form: one sketch, current version, pictures inside.
  const src = Project.fromJSON(sourceJSON).toJSON();
  const sj0 = src.sketches && src.sketches[0];
  if (!sj0 || !((sj0.entities || []).length || (sj0.strokes || []).length)) return null;
  const title = String(name || src.name || 'Part').trim().slice(0, 60) || 'Part';

  // 1. New ids for everything (layers, shapes, points, relations, ink, groups).
  const ids = new Set();
  collectIds(src.layers, ids); collectIds(sj0, ids);
  const map = new Map();
  for (const id of ids) map.set(id, newId((/^[A-Za-z]+/.exec(id) || ['e'])[0]));
  let layers = remap(src.layers || [], map);
  let sj = remap(sj0, map);

  // 2. Nothing pins the part to the page.
  const before = (sj.constraints || []).length;
  sj.constraints = (sj.constraints || []).filter(c => !PINS.has(c.kind));
  const pinsDropped = before - sj.constraints.length;

  // 3. Names that are taken get new ones; formulas follow.
  const used = new Set(target.variables.map(v => v.name));
  for (const s of target.sketches) for (const c of s.constraints) if (c.name) used.add(c.name);
  const names = new Map();
  const variables = [];
  for (const v of src.variables || []) {
    // The same variable (same name, or the name an earlier insert of this
    // part gave it, and the same formula) is shared rather than repeated.
    const mine = target.variables.find(t => t.expr === v.expr && (t.name === v.name || t.name.startsWith(v.name + '_')));
    if (mine) { if (mine.name !== v.name) names.set(v.name, mine.name); continue; }
    let n = v.name;
    if (used.has(n)) { n = nextFree(v.name + '_', used, 2); names.set(v.name, n); }
    used.add(n);
    variables.push({ name: n, expr: v.expr });
  }
  for (const c of sj.constraints) {
    if (!c.name) continue;
    if (used.has(c.name)) { const n = nextFree((/^[A-Za-z_]+/.exec(c.name) || ['D'])[0], used); names.set(c.name, n); c.name = n; }
    used.add(c.name);
  }
  if (names.size) {
    sj = { ...sj, constraints: renameFormulas(sj.constraints, names) };
    for (const v of variables) v.expr = renameInFormula(v.expr, names);
  }

  // 4. Move it so its middle lands on `at`.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  eachPoint(sj, (o, kx, ky, r, _c, soft) => {
    if (soft) return;                                           // seeds, frames: inside what is measured anyway
    minX = Math.min(minX, o[kx] - r); maxX = Math.max(maxX, o[kx] + r);
    minY = Math.min(minY, o[ky] - r); maxY = Math.max(maxY, o[ky] + r);
  });
  if (minX === Infinity) return null;
  const dx = at ? at.x - (minX + maxX) / 2 : 0, dy = at ? at.y - (minY + maxY) / 2 : 0;
  if (dx || dy) {
    const moved = new Set();
    eachPoint(sj, (o, kx, ky) => {
      const tag = o === Object(o) && !Array.isArray(o) ? o : null;
      if (tag) { if (moved.has(tag)) return; moved.add(tag); }
      o[kx] += dx; o[ky] += dy;
    });
  }

  // 5. Its layers, named after it, on top of the drawing's own.
  const same = (n) => String(n || '').trim().toLowerCase() === title.toLowerCase();
  layers = layers.map(l => ({ ...l, name: (layers.length > 1 && !same(l.name) ? `${title}: ${l.name}` : title).slice(0, 80), visible: true }));

  // Revive through the normal loader, then move the contents across.
  const part = Project.fromJSON({ version: 3, name: title, layers, sketches: [{ ...sj, name: base.name }], images: src.images });
  const ps = part.active();
  for (const l of part.layers) target.layers.push(l);
  const entityIds = [], strokeIds = [];
  for (const e of ps.entities) {
    e.sketchId = base.id;
    base.entities.push(e);
    entityIds.push(e.id);
    const mark = (x) => { base.dirtyIds.add(x.id); for (const c of x.children()) mark(c); };
    mark(e);
  }
  base.constraints.push(...ps.constraints);
  base.features.push(...(ps.features || []));
  base.fills.push(...ps.fills);
  for (const s of ps.strokes) { base.strokes.push(s); strokeIds.push(s.id); }
  target.variables.push(...variables);
  return {
    entityIds, strokeIds, layerIds: part.layers.map(l => l.id), name: title, pinsDropped,
    bounds: { minX: minX + dx, minY: minY + dy, maxX: maxX + dx, maxY: maxY + dy },
  };
}

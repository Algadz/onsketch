import { Constraint } from './constraints.js';
import { Arc, Circle, Line, Point } from './entities.js';

/* =============== PATTERNS =======================================
   Linear, circular and point ("sketch-driven") patterns of geometry,
   as in SolidWorks. A pattern repeats seed shapes (lines, circles,
   arcs, points) as copies placed by a transform per instance:

     linear    instance (i, j) = seed moved by i·spacing1 along
               direction 1 and j·spacing2 along direction 2. A direction
               is an angle, or follows a line (and turns with it).
     circular  instance k = seed turned by k·step about a centre point.
     points    one instance per target point: the seed moved so that
               its origin point lands on the target.

   A **linked** pattern is a PatternConstraint: its residuals tie every
   copy to its seed through the transform, so the solver keeps copies
   following the seed, the centre, the direction line and the target
   points, and the pattern's parameters stay editable (syncPattern adds
   or removes copies when the counts change). An **unlinked** pattern is
   plain copies carrying the seed's own relations.

   Instances: [{ key, pairs: [[seedId, copyId, kind]] }] with kind
     'p' a point (x, y)       'r' a circle (radius)
     'a' an arc (r, a0, a1)   'e' identity only (lines, arc ends)
   Point references (centre, origin, targets) are { id } for a point of
   the drawing or { x, y } for a fixed spot (a deleted point freezes
   where it was). Angles are stored in degrees, as the user types them.
   ============================================================ */

export const PATTERN_TYPES = ['linear', 'circular', 'points'];
export const PATTERN_LABELS = { linear: 'Linear pattern', circular: 'Circular pattern', points: 'Point pattern' };
/** Copies per pattern at most: the solver works on every copy. */
export const PATTERN_MAX_COPIES = 200;

const DEG = Math.PI / 180;
const wrap = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const int = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Math.round(num(v, d))));

function cleanRef(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id === 'string') return { id: r.id };
  if (Number.isFinite(r.x) && Number.isFinite(r.y)) return { x: r.x, y: r.y };
  return null;
}
function cleanLine(l) {
  return l && typeof l.a === 'string' && typeof l.b === 'string'
    ? { a: l.a, b: l.b, ...(typeof l.id === 'string' ? { id: l.id } : {}) } : null;
}
function cleanDir(d, angle) {
  d = d || {};
  return {
    count: int(d.count, 1, 1, PATTERN_MAX_COPIES + 1),
    spacing: num(d.spacing, 20),
    angle: num(d.angle, angle),
    line: cleanLine(d.line),
    reverse: !!d.reverse,
  };
}

/** Parameters of a new pattern of this type. */
export function defaultPatternParams(type) {
  if (type === 'circular') return { center: null, count: 6, angle: 360, equal: true, reverse: false };
  if (type === 'points') return { origin: null, targets: [] };
  return { d1: { count: 3, spacing: 20, angle: 0, line: null, reverse: false },
           d2: { count: 1, spacing: 20, angle: 90, line: null, reverse: false } };
}

/** Sanitised copy of a pattern's parameters (files, undo, the UI). */
export function cleanPatternParams(type, p) {
  p = p || {};
  const exprs = {};
  if (p.exprs && typeof p.exprs === 'object') {
    for (const [k, v] of Object.entries(p.exprs)) if (typeof v === 'string' && v.trim()) exprs[k] = v;
  }
  const withExprs = (o) => (Object.keys(exprs).length ? { ...o, exprs } : o);
  if (type === 'circular') {
    return withExprs({
      center: cleanRef(p.center),
      count: int(p.count, 6, 1, PATTERN_MAX_COPIES + 1),
      angle: num(p.angle, 360),
      equal: p.equal !== false,
      reverse: !!p.reverse,
    });
  }
  if (type === 'points') {
    const seen = new Set();
    const targets = [];
    for (const t of Array.isArray(p.targets) ? p.targets : []) {
      const ref = cleanRef(t);
      const key = typeof t?.key === 'string' ? t.key : (ref?.id || null);
      if (!ref || !key || seen.has(key)) continue;
      seen.add(key);
      targets.push({ key, ...ref });
    }
    return withExprs({ origin: cleanRef(p.origin), targets });
  }
  return withExprs({ d1: cleanDir(p.d1, 0), d2: cleanDir(p.d2, 90) });
}

/** Angle between instances of a circular pattern, in degrees. With equal
 *  spacing the angle is the total: a full turn shares it among all the
 *  instances, a part turn puts the last one at its end. */
export function circularStep(p) {
  const n = Math.max(1, p.count | 0);
  if (!p.equal) return p.angle;
  if (Math.abs(p.angle) >= 360 - 1e-9) return p.angle / n;
  return n > 1 ? p.angle / (n - 1) : 0;
}

/** Keys of every copy (the seed excluded), in order. */
export function patternKeys(type, p) {
  const out = [];
  if (type === 'linear') {
    for (let j = 0; j < p.d2.count; j++) {
      for (let i = 0; i < p.d1.count; i++) if (i || j) out.push(i + ',' + j);
    }
  } else if (type === 'circular') {
    for (let k = 1; k < p.count; k++) out.push(String(k));
  } else if (type === 'points') {
    for (const t of p.targets) out.push(t.key);
  }
  return out;
}

/** Number of copies a pattern makes. */
export function patternCopyCount(type, p) {
  if (type === 'linear') return p.d1.count * p.d2.count - 1;
  if (type === 'circular') return Math.max(0, p.count - 1);
  return p.targets.length;
}

/** Position of a point reference: P(id) → {x, y} for points of the drawing. */
export function refPoint(ref, P) {
  if (!ref) return null;
  if (ref.id) return P(ref.id);
  return Number.isFinite(ref.x) ? { x: ref.x, y: ref.y } : null;
}

/** Unit vector of a linear direction. */
export function directionVector(d, P) {
  let ux = Math.cos(d.angle * DEG), uy = Math.sin(d.angle * DEG);
  if (d.line) {
    const a = P(d.line.a), b = P(d.line.b);
    if (a && b) {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len > 1e-12) { ux = dx / len; uy = dy / len; }
    }
  }
  return d.reverse ? { x: -ux, y: -uy } : { x: ux, y: uy };
}

/** Transform of one instance: { rot (radians), map(p) → p' }, or null
 *  when the pattern is missing what places it (no centre yet…). */
export function patternTransform(type, p, key, P) {
  if (type === 'linear') {
    const [i, j] = String(key).split(',').map(Number);
    const u1 = directionVector(p.d1, P), u2 = directionVector(p.d2, P);
    const dx = i * p.d1.spacing * u1.x + j * p.d2.spacing * u2.x;
    const dy = i * p.d1.spacing * u1.y + j * p.d2.spacing * u2.y;
    return { rot: 0, map: (q) => ({ x: q.x + dx, y: q.y + dy }) };
  }
  if (type === 'circular') {
    const c = refPoint(p.center, P);
    if (!c) return null;
    const th = Number(key) * circularStep(p) * DEG * (p.reverse ? -1 : 1);
    const cs = Math.cos(th), sn = Math.sin(th);
    return {
      rot: th,
      map: (q) => {
        const vx = q.x - c.x, vy = q.y - c.y;
        return { x: c.x + vx * cs - vy * sn, y: c.y + vx * sn + vy * cs };
      },
    };
  }
  if (type === 'points') {
    const t = p.targets.find(x => x.key === key);
    const o = refPoint(p.origin, P), tp = refPoint(t, P);
    if (!o || !tp) return null;
    const dx = tp.x - o.x, dy = tp.y - o.y;
    return { rot: 0, map: (q) => ({ x: q.x + dx, y: q.y + dy }) };
  }
  return null;
}

/** Ids of the points that place the copies of one instance (key) or of
 *  all instances (key undefined): centre, origin, targets, direction lines. */
export function patternRefIds(type, p, key) {
  const out = [];
  const add = (r) => { if (r?.id) out.push(r.id); };
  if (type === 'linear') {
    for (const d of [p.d1, p.d2]) if (d.line) out.push(d.line.a, d.line.b);
  } else if (type === 'circular') add(p.center);
  else if (type === 'points') {
    add(p.origin);
    for (const t of p.targets) if (key === undefined || t.key === key) add(t);
  }
  return out;
}

export class PatternConstraint extends Constraint {
  constructor(type, params, seeds = [], instances = [], skipped = []) {
    super('pattern');
    this.type = PATTERN_TYPES.includes(type) ? type : 'linear';
    this.params = cleanPatternParams(this.type, params);
    this.seeds = [...seeds];
    this.instances = instances.map(i => ({ key: String(i.key), pairs: i.pairs.map(pr => [...pr]) }));
    this.skipped = [...skipped];
  }
  /** Seeds and copies (not the points that place them). */
  memberIds() {
    const out = new Set(this.seeds);
    for (const inst of this.instances) for (const [s, d] of inst.pairs) { out.add(s); out.add(d); }
    return out;
  }
  copyIds() {
    const out = new Set();
    for (const inst of this.instances) for (const pr of inst.pairs) out.add(pr[1]);
    return out;
  }
  refs() {
    const out = this.memberIds();
    for (const id of patternRefIds(this.type, this.params)) out.add(id);
    return [...out];
  }
  /** Links for the solver's / drag's connectivity graphs: each copy to
   *  its seed and to what places it, the seed parts to one hub. The usual
   *  all-pairs links would be O(n²) for a big pattern. */
  graphLinks() {
    const links = [];
    const hub = this.seeds[0];
    for (const id of this.seeds) if (hub) links.push([hub, id]);
    for (const inst of this.instances) {
      const refs = patternRefIds(this.type, this.params, inst.key);
      for (const [s, d] of inst.pairs) {
        links.push([s, d]);
        if (hub) links.push([hub, s]);
        for (const r of refs) links.push([r, d]);
      }
    }
    return links;
  }
  residuals(L) {
    const P = (id) => ({ x: L(id, 'x'), y: L(id, 'y') });
    const f = [];
    for (const inst of this.instances) {
      const T = patternTransform(this.type, this.params, inst.key, P);
      for (const [s, d, kind] of inst.pairs) {
        if (kind === 'p') {
          if (!T) { f.push(0, 0); continue; }
          const q = T.map(P(s));
          f.push(L(d, 'x') - q.x, L(d, 'y') - q.y);
        } else if (kind === 'r') {
          f.push(L(d, 'r') - L(s, 'r'));
        } else if (kind === 'a') {
          const rot = T ? T.rot : 0;
          f.push(L(d, 'r') - L(s, 'r'),
            wrap(L(d, 'a0') - L(s, 'a0') - rot),
            wrap(L(d, 'a1') - L(s, 'a1') - rot));
        }
      }
    }
    return f;
  }
  /** Shapes are being deleted (Sketch.removeEntity). A deleted copy leaves
   *  its instance out from then on; a deleted seed takes its copies out of
   *  the pattern; a deleted centre, origin, target or direction line is
   *  frozen where it was. @returns false when nothing is left to pattern. */
  prune(stale, removed = new Map()) {
    const freeze = (r) => {
      if (!r?.id || !stale.has(r.id)) return r;
      const p = removed.get(r.id);
      return p && Number.isFinite(p.x) ? { x: p.x, y: p.y } : null;
    };
    const p = this.params;
    if (this.type === 'circular') p.center = freeze(p.center);
    if (this.type === 'points') {
      p.origin = freeze(p.origin);
      p.targets = p.targets.map(t => { const f = freeze(t); return f ? { key: t.key, ...f } : null; }).filter(Boolean);
    }
    if (this.type === 'linear') {
      for (const d of [p.d1, p.d2]) {
        if (!d.line || (!stale.has(d.line.a) && !stale.has(d.line.b))) continue;
        const a = removed.get(d.line.a), b = removed.get(d.line.b);
        if (a && b && Math.hypot(b.x - a.x, b.y - a.y) > 1e-12) d.angle = Math.atan2(b.y - a.y, b.x - a.x) / DEG;
        d.line = null;
      }
    }
    const seedGone = new Set(this.seeds.filter(id => stale.has(id)));
    this.seeds = this.seeds.filter(id => !stale.has(id));
    this.instances = this.instances.filter(inst => {
      const before = inst.pairs.length;
      inst.pairs = inst.pairs.filter(([s, d]) => !stale.has(s) && !stale.has(d));
      if (inst.pairs.length) return true;
      // Emptied by deleting its copies (not its seeds): skipped from now on.
      if (before && !seedGone.size && !this.skipped.includes(inst.key)) this.skipped.push(inst.key);
      return false;
    });
    if (this.type === 'points') this.skipped = this.skipped.filter(k => p.targets.some(t => t.key === k));
    return this.seeds.length > 0;
  }
  toJSON() {
    const o = { id: this.id, kind: 'pattern', type: this.type, params: this.params,
      seeds: this.seeds, instances: this.instances };
    if (this.skipped.length) o.skipped = this.skipped;
    return o;
  }
  static fromJSON(o) {
    if (!o || !Array.isArray(o.seeds)) return null;
    const instances = (Array.isArray(o.instances) ? o.instances : [])
      .filter(i => i && i.key != null && Array.isArray(i.pairs))
      .map(i => ({ key: String(i.key), pairs: i.pairs.filter(pr => Array.isArray(pr) && pr.length === 3) }));
    const c = new PatternConstraint(o.type, o.params, o.seeds.filter(s => typeof s === 'string'), instances,
      Array.isArray(o.skipped) ? o.skipped.map(String) : []);
    return c;
  }
}

/* ---------------- Building copies ---------------- */

/** Points of the drawing by id (including line ends, centres). */
function pointLookup(sketch) {
  const byId = new Map();
  for (const e of sketch.entities) {
    byId.set(e.id, e);
    for (const ch of e.children()) if (!byId.has(ch.id)) byId.set(ch.id, ch);
  }
  return byId;
}

/** Ids of a top-level shape and everything it owns. */
export function ownIds(e) {
  const ids = [e.id];
  for (const ch of e.children()) ids.push(ch.id);
  return ids;
}

/**
 * One copy of `seed` through transform T. Points already copied for this
 * instance (shared corners) are reused through `pointMap` (seed point id →
 * copy point). Returns { entity, pairs, points } or null.
 */
export function copyShape(seed, T, pointMap) {
  const pairs = [];
  const fresh = [];
  const pt = (p) => {
    const have = pointMap.get(p.id);
    if (have) return have;
    const q = T.map(p);
    const np = new Point(q.x, q.y);
    pointMap.set(p.id, np);
    pairs.push([p.id, np.id, 'p']);
    fresh.push(np);
    return np;
  };
  let e = null;
  if (seed instanceof Line) {
    e = new Line(pt(seed.p1), pt(seed.p2));
    pairs.push([seed.id, e.id, 'e']);
  } else if (seed instanceof Arc) {
    e = new Arc(pt(seed.center), seed.r, seed.a0 + T.rot, seed.a1 + T.rot);
    e.clockwise = !!seed.clockwise;
    e.syncEnds();
    pairs.push([seed.id, e.id, 'a'], [seed.start.id, e.start.id, 'e'], [seed.end.id, e.end.id, 'e']);
  } else if (seed instanceof Circle) {
    e = new Circle(pt(seed.center), seed.r);
    pairs.push([seed.id, e.id, 'r']);
  } else if (seed instanceof Point) {
    if (pointMap.has(seed.id)) return null;      // already there as a corner of another copy
    const q = T.map(seed);
    e = new Point(q.x, q.y);
    pointMap.set(seed.id, e);
    pairs.push([seed.id, e.id, 'p']);
  }
  if (!e) return null;
  e.construction = !!seed.construction;
  return { entity: e, pairs, points: fresh };
}

/**
 * Brings the copies of a pattern in line with its type, parameters and
 * seeds: instances that no longer exist lose their copies, missing copies
 * are made (placed by the transform from the current geometry), copies of
 * seeds no longer in the pattern go. Copies take their seed's layer and
 * style. Existing copies keep their ids, so relations, dimensions, fills
 * and ink on them survive a change of spacing or count.
 * @returns {{ added: Entity[], removed: number }}
 */
export function syncPattern(sketch, c) {
  const byId = pointLookup(sketch);
  const seeds = c.seeds.map(id => byId.get(id)).filter(e => e && sketch.entities.includes(e));
  c.seeds = seeds.map(e => e.id);
  const wanted = patternKeys(c.type, c.params).filter(k => !c.skipped.includes(k));
  const wantedSet = new Set(wanted);
  const removeTop = new Set();
  const added = [];

  // Instances that went away, and copies of seeds that left the pattern.
  // Pairs are dropped before the shapes go, so Sketch.removeEntity's
  // prune doesn't read the removal as the user deleting copies.
  const seedOwnIds = new Set();
  for (const s of seeds) for (const id of ownIds(s)) seedOwnIds.add(id);
  const tops = new Set(sketch.entities);
  const keep = [];
  for (const inst of c.instances) {
    const gone = !wantedSet.has(inst.key);
    const pairs = [];
    for (const pr of inst.pairs) {
      if (gone || !seedOwnIds.has(pr[0])) {
        const d = byId.get(pr[1]);
        if (d && tops.has(d)) removeTop.add(d);    // corners go with their shape
      } else pairs.push(pr);
    }
    if (!gone) keep.push({ key: inst.key, pairs });
  }
  c.instances = keep;
  for (const e of removeTop) sketch.removeEntity(e);
  const live = pointLookup(sketch);

  const byKey = new Map(c.instances.map(i => [i.key, i]));
  const ordered = [];
  for (const key of wanted) {
    let inst = byKey.get(key);
    if (!inst) inst = { key, pairs: [] };
    inst.pairs = inst.pairs.filter(pr => live.has(pr[1]));
    const T = patternTransform(c.type, c.params, key, (id) => live.get(id) || null);
    if (T) {
      const pointMap = new Map();
      const have = new Set();
      for (const [s, d, kind] of inst.pairs) {
        have.add(s);
        if (kind === 'p') { const q = live.get(d); if (q) pointMap.set(s, q); }
      }
      for (const seed of seeds) {
        if (have.has(seed.id)) continue;
        const made = copyShape(seed, T, pointMap);
        if (!made) continue;
        sketch.addEntity(made.entity);
        made.entity.layerId = seed.layerId;
        made.entity.style = seed.style ? { ...seed.style } : null;
        inst.pairs.push(...made.pairs);
        added.push(made.entity);
        live.set(made.entity.id, made.entity);
        for (const ch of made.entity.children()) live.set(ch.id, ch);
      }
    }
    if (inst.pairs.length || !T) ordered.push(inst);
  }
  c.instances = ordered;
  return { added, removed: removeTop.size };
}

/** Puts every copy exactly where its transform says, from the current
 *  seed, centre, targets…: after a parameter change the solver then has
 *  nothing to move (the seed stays where it is rather than meeting its
 *  copies half way). */
export function placePatternCopies(sketch, c) {
  const byId = pointLookup(sketch);
  const P = (id) => byId.get(id) || null;
  for (const inst of c.instances) {
    const T = patternTransform(c.type, c.params, inst.key, P);
    if (!T) continue;
    for (const [s, d, kind] of inst.pairs) {
      const a = byId.get(s), b = byId.get(d);
      if (!a || !b) continue;
      if (kind === 'p') { const q = T.map(a); b.x = q.x; b.y = q.y; }
      else if (kind === 'r') b.r = a.r;
      else if (kind === 'a') { b.r = a.r; b.a0 = a.a0 + T.rot; b.a1 = a.a1 + T.rot; }
    }
    for (const [, d, kind] of inst.pairs) if (kind === 'a') byId.get(d)?.syncEnds?.();
  }
}

/** Removes every copy of a pattern (the seeds stay). */
export function removePatternCopies(sketch, c) {
  const byId = pointLookup(sketch);
  const tops = new Set();
  for (const inst of c.instances) {
    for (const [, d] of inst.pairs) {
      const e = byId.get(d);
      if (e && sketch.entities.includes(e)) tops.add(e);
    }
  }
  c.instances = [];
  for (const e of tops) sketch.removeEntity(e);
  return tops.size;
}

/** Seed id → copy id for one instance (for copying relations). */
export function instanceIdMap(inst) {
  const m = new Map();
  for (const [s, d] of inst.pairs) m.set(s, d);
  return m;
}

/** Bounding box of shapes: { minX, minY, maxX, maxY } or null. */
export function shapesBBox(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const e of shapes) {
    if (e instanceof Line) { acc(e.p1.x, e.p1.y); acc(e.p2.x, e.p2.y); }
    else if (e instanceof Circle || e instanceof Arc) { acc(e.center.x - e.r, e.center.y - e.r); acc(e.center.x + e.r, e.center.y + e.r); }
    else if (e instanceof Point) acc(e.x, e.y);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** First point of a shape (where a point pattern's origin defaults to). */
export function shapeReferencePoint(e) {
  if (e instanceof Line) return e.p1;
  if (e instanceof Circle || e instanceof Arc) return e.center;
  if (e instanceof Point) return e;
  return null;
}

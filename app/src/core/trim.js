import * as C from './constraints.js';
import { Arc, Circle, Line, Point } from './entities.js';

/* =============== SCISSORS: TRIM AND SPLIT =======================
   Trim removes the piece of a line, circle or arc between the two
   nearest places where other geometry of the layer crosses or touches it
   (SolidWorks' "trim to closest"); with nothing crossing it, the whole
   shape goes. Split cuts a shape in two at a point (a circle at two).

   What happens to relations and dimensions:

   kept, on the piece that keeps the shape's id (the first one):
     everything that is about the infinite line / the circle: horizontal,
     vertical, parallel, perpendicular, collinear, angle, tangent, point
     on line / circle, symmetric about it, point–line distance, offset,
     radius / diameter, equal radius, concentric, fix and dimensions on
     points that are still there (corners, centres).
   carried to the second piece (middle trim, split):
     what was on the far end (its point moves to that piece, arc 'end'
     relations follow the arc's end), plus a relation that keeps the two
     pieces one shape: Collinear for lines, the same centre + Equal radius
     for arcs (+ a Coincident joint after a split).
   added at a cut:
     the new end stays on what cut it: Point on line / Point on circle,
     or Coincident when it's cut at an existing point (that point becomes
     the end, shared) or at an arc's end.
   removed:
     relations about the length of the line (Equal length, Midpoint), and
     whatever was on a piece or end that's gone (dimensions to it…).

   Shapes keep their ids (a trimmed circle becomes an arc with the
   circle's id), so fills, ink links and dimension names stay put.
   ============================================================ */

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;
/** Two positions closer than this (drawing units) are the same place. */
export const TRIM_TOL = 1e-6;

/* ---------------- parameters along a shape ---------------- */

/** Length of the arc's sweep (radians, > 0), in its own direction. */
export function arcSpan(a) { return a.clockwise ? norm(a.a0 - a.a1) : norm(a.a1 - a.a0); }
/** Angle → distance along the arc from its start (radians). */
export function arcU(a, theta) { return a.clockwise ? norm(a.a0 - theta) : norm(theta - a.a0); }
export function arcAngle(a, u) { return a.a0 + (a.clockwise ? -u : u); }

/** Where a world point falls along the shape: lines t ∈ [0,1], arcs the
 *  angle from the start, circles the angle. */
export function paramOf(e, p) {
  if (e instanceof Line) {
    const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y, L2 = dx * dx + dy * dy;
    if (L2 < 1e-24) return 0;
    return Math.max(0, Math.min(1, ((p.x - e.p1.x) * dx + (p.y - e.p1.y) * dy) / L2));
  }
  const th = Math.atan2(p.y - e.center.y, p.x - e.center.x);
  if (e instanceof Arc) {
    const u = arcU(e, th), span = arcSpan(e);
    if (u <= span) return u;
    return (u - span) < (TAU - u) ? span : 0;          // off the arc: nearest end
  }
  return norm(th);
}

export function pointAt(e, u) {
  if (e instanceof Line) return { x: e.p1.x + (e.p2.x - e.p1.x) * u, y: e.p1.y + (e.p2.y - e.p1.y) * u };
  const th = e instanceof Arc ? arcAngle(e, u) : u;
  return { x: e.center.x + e.r * Math.cos(th), y: e.center.y + e.r * Math.sin(th) };
}

/** Parameter length of the shape (1 for lines, the sweep, or 2π). */
const paramEnd = (e) => (e instanceof Line ? 1 : e instanceof Arc ? arcSpan(e) : TAU);
/** Drawing units per unit of parameter (to compare with a tolerance). */
const paramScale = (e) => (e instanceof Line ? Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y) : e.r);

/* ---------------- intersections ---------------- */

/** Segments ab and cd: where their lines meet, t along ab, s along cd. */
function segSeg(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14 * (Math.hypot(rx, ry) * Math.hypot(sx, sy) + 1e-300)) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const s = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return { x: a.x + t * rx, y: a.y + t * ry, t, s };
}
function segCircle(a, b, c, r) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - c.x, fy = a.y - c.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), Cc = fx * fx + fy * fy - r * r;
  if (A < 1e-24) return [];
  let disc = B * B - 4 * A * Cc;
  if (disc < -1e-12 * A * r * r) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ts.map(t => ({ x: a.x + t * dx, y: a.y + t * dy, s: t }));
}
function circleCircle(c1, r1, c2, r2) {
  const dx = c2.x - c1.x, dy = c2.y - c1.y, d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1.x + a * dx / d, my = c1.y + a * dy / d;
  if (h < 1e-9) return [{ x: mx, y: my }];
  return [{ x: mx + h * dy / d, y: my - h * dx / d }, { x: mx - h * dy / d, y: my + h * dx / d }];
}

/** Places where `o` crosses / touches shape `e` (world points on both). */
export function crossings(e, o) {
  const inSeg = (t) => t >= -1e-9 && t <= 1 + 1e-9;
  const onArc = (a, p) => !(a instanceof Arc) || arcU(a, Math.atan2(p.y - a.center.y, p.x - a.center.x)) <= arcSpan(a) + 1e-9;
  const xy = (p) => ({ x: p.x, y: p.y });
  if (e instanceof Line && o instanceof Line) {
    const r = segSeg(e.p1, e.p2, o.p1, o.p2);
    return r && inSeg(r.t) && inSeg(r.s) ? [xy(r)] : [];
  }
  if (e instanceof Line) return segCircle(e.p1, e.p2, o.center, o.r).filter(p => inSeg(p.s) && onArc(o, p)).map(xy);
  if (o instanceof Line) return segCircle(o.p1, o.p2, e.center, e.r).filter(p => inSeg(p.s) && onArc(e, p)).map(xy);
  return circleCircle(e.center, e.r, o.center, o.r).filter(p => onArc(e, p) && onArc(o, p)).map(xy);
}

const isCurve = (e) => e instanceof Line || e instanceof Circle || e instanceof Arc;
const distTo = (e, p) => {
  if (e instanceof Line) { const q = pointAt(e, paramOf(e, p)); return Math.hypot(q.x - p.x, q.y - p.y); }
  const d = Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.r);
  if (e instanceof Arc && arcU(e, Math.atan2(p.y - e.center.y, p.x - e.center.x)) > arcSpan(e) + 1e-9) return Infinity;
  return d;
};

/**
 * Where shape `e` is cut by the rest of the layer, sorted along it:
 * [{ u, x, y, cutter?, point?, arcEnd? }]. `point` is an existing point
 * lying on e there (another shape's end, a sketch point…): the cut reuses
 * it. Cuts at e's own ends are left out (nothing to cut there).
 */
export function findCuts(sketch, e, opts = {}) {
  const tol = opts.tol || TRIM_TOL, cutter = opts.cutter || (() => true);
  const raw = [];
  const own = new Set([e, ...e.children()]);
  const end = paramEnd(e), scale = paramScale(e) || 1;
  const inside = (u) => (e instanceof Circle) || (u * scale > tol * 10 && (end - u) * scale > tol * 10);
  for (const o of sketch.entities) {
    if (o === e || !cutter(o)) continue;
    if (isCurve(o)) {
      for (const p of crossings(e, o)) {
        const u = paramOf(e, p);
        if (inside(u)) raw.push({ u, x: p.x, y: p.y, cutter: o });
      }
    }
    // points lying on e: sketch points and other shapes' ends (not centres)
    const pts = o instanceof Point ? [o] : o instanceof Line ? o.children() : o instanceof Arc ? [o.start, o.end] : [];
    for (const p of pts) {
      if (own.has(p) || distTo(e, p) > tol * 10) continue;
      const u = paramOf(e, p);
      if (!inside(u)) continue;
      if (p.arcOwner) raw.push({ u, x: p.x, y: p.y, arcEnd: { arc: p.arcOwner, which: p.arcEndpoint } });
      else raw.push({ u, x: p.x, y: p.y, point: p });
    }
  }
  raw.sort((a, b) => a.u - b.u);
  // merge cuts at the same place; an existing point wins (it's reused)
  const out = [];
  for (const c of raw) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - c.x, last.y - c.y) < tol * 100) {
      if (!last.point && c.point) { last.point = c.point; last.x = c.x; last.y = c.y; last.u = c.u; }
      if (!last.arcEnd && c.arcEnd) last.arcEnd = c.arcEnd;
      if (!last.cutter && c.cutter) last.cutter = c.cutter;
      continue;
    }
    out.push({ ...c });
  }
  if (e instanceof Circle && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) < tol * 100) out.pop();
  }
  return out;
}

/**
 * The piece of `e` under world point `at`, bounded by the nearest cuts:
 * { e, lo, hi, whole } where lo / hi are cuts (null = the shape's own end).
 * For a circle, lo → hi runs counter-clockwise; whole when fewer than 2 cuts.
 */
export function pieceAt(sketch, e, at, opts = {}) {
  const cuts = findCuts(sketch, e, opts);
  const u = paramOf(e, at);
  if (e instanceof Circle) {
    if (cuts.length < 2) return { e, lo: null, hi: null, whole: true, cuts };
    let i = cuts.findIndex(c => c.u > u);
    if (i < 0) i = 0;
    const hi = cuts[i], lo = cuts[(i - 1 + cuts.length) % cuts.length];
    return { e, lo, hi, whole: false, cuts };
  }
  let lo = null, hi = null;
  for (const c of cuts) { if (c.u < u) lo = c; else if (!hi) hi = c; }
  return { e, lo, hi, whole: !lo && !hi, cuts };
}

/** Drawable outline of a piece (for the hover preview). */
export function pieceShape(piece) {
  const e = piece.e;
  if (e instanceof Line) {
    const a = piece.lo ? piece.lo : e.p1, b = piece.hi ? piece.hi : e.p2;
    return { kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
  }
  if (e instanceof Circle) {
    if (piece.whole) return { kind: 'circle', center: { x: e.center.x, y: e.center.y }, r: e.r };
    let a1 = piece.hi.u;
    if (a1 <= piece.lo.u) a1 += TAU;
    return { kind: 'arc', center: { x: e.center.x, y: e.center.y }, r: e.r, a0: piece.lo.u, a1, clockwise: false };
  }
  const u0 = piece.lo ? piece.lo.u : 0, u1 = piece.hi ? piece.hi.u : arcSpan(e);
  return { kind: 'arc', center: { x: e.center.x, y: e.center.y }, r: e.r, a0: arcAngle(e, u0), a1: arcAngle(e, u1), clockwise: !!e.clockwise };
}

/* ---------------- relation bookkeeping ---------------- */

const sameSet = (l, a, b) => l && typeof l === 'object' && ((l.a === a && l.b === b) || (l.a === b && l.b === a));
const PAIR_KEYS = ['l', 'l1', 'l2', 'axis'];
const REF_KEYS = ['ref', 'ref1', 'ref2'];
/** Relations about a line's length, not its direction: they go when the line is cut. */
const LENGTH_KINDS = new Set(['equalLength', 'midpoint', 'arcEndpointMidpoint']);

/** Moves relations of line (A, B) onto (A2, B2), oriented the same way.
 *  Returns the dropped constraints. */
function retargetLine(sketch, line, A, B, A2, B2) {
  const dropped = [];
  const swap = (l) => (l.a === A ? { a: A2, b: B2 } : { a: B2, b: A2 });
  sketch.constraints = sketch.constraints.filter(c => {
    let hit = false;
    for (const k of PAIR_KEYS) if (sameSet(c[k], A, B)) hit = true;
    if (c.kind === 'offsetDistance') for (const p of c.pairs) if (p.l && sameSet(p.l, A, B)) hit = true;
    const hv = (c.kind === 'horizontal' || c.kind === 'vertical')
      && (c.lineId === line.id || (!c.lineId && ((c.p1 === A && c.p2 === B) || (c.p1 === B && c.p2 === A))));
    if (!hit && !hv) return true;
    if (hit && LENGTH_KINDS.has(c.kind)) { dropped.push(c); return false; }
    for (const k of PAIR_KEYS) if (sameSet(c[k], A, B)) c[k] = swap(c[k]);
    if (c.kind === 'offsetDistance') c.pairs = c.pairs.map(p => (p.l && sameSet(p.l, A, B) ? { ...p, l: swap(p.l) } : p));
    if (hv) {
      const flip = c.p1 === B;
      c.p1 = flip ? B2 : A2; c.p2 = flip ? A2 : B2;
      c.lineId = line.id;
    }
    return true;
  });
  return dropped;
}

/** Drops relations that now say nothing or can't hold: references to
 *  points / shapes that are gone, a point "on" a line it ends… */
function pruneStale(sketch) {
  const live = new Set();
  for (const e of sketch.entities) { live.add(e.id); for (const ch of e.children()) live.add(ch.id); }
  const dropped = [];
  sketch.constraints = sketch.constraints.filter(c => {
    const refs = c.refs().filter(Boolean);
    let bad = refs.some(id => !live.has(id));
    if (!bad && (c.kind === 'pointOnLine' || c.kind === 'midpoint') && (c.pointId === c.l.a || c.pointId === c.l.b)) bad = true;
    if (!bad && c.l && c.l.a === c.l.b) bad = true;
    if (!bad && c.kind === 'coincident' && c.p1 === c.p2) bad = true;
    if (!bad && (c.kind === 'collinear' || c.kind === 'parallel') && sameSet(c.l1, c.l2?.a, c.l2?.b)) bad = true;
    if (bad) dropped.push(c);
    return !bad;
  });
  return dropped;
}

/** Arc-end references to (arc, which): drop them, or move them to another arc. */
function arcEndRefs(sketch, arc, which, moveTo = null) {
  const dropped = [];
  sketch.constraints = sketch.constraints.filter(c => {
    let hit = false;
    for (const k of REF_KEYS) if (c[k] && c[k].arcId === arc.id && c[k].which === which) hit = true;
    const endPt = which === 'start' ? arc.start.id : arc.end.id;
    const plain = c.refs().includes(endPt);
    if (!hit && !plain) return true;
    if (moveTo && !plain) {
      for (const k of REF_KEYS) {
        if (c[k] && c[k].arcId === arc.id && c[k].which === which) c[k] = { ...c[k], arcId: moveTo.id, centerId: moveTo.center.id };
      }
      return true;
    }
    dropped.push(c);
    return false;
  });
  return dropped;
}

const tag = (c, like) => { if (like.layerId) c.layerId = like.layerId; return c; };

/** New shape like `src` (layer, style, construction), added after it. */
function addLike(sketch, e, src) {
  const i = sketch.entities.indexOf(src);
  sketch.addEntity(e);
  sketch.entities.pop();
  sketch.entities.splice(i < 0 ? sketch.entities.length : i + 1, 0, e);
  e.layerId = src.layerId;
  e.style = src.style ? { ...src.style } : null;
  e.construction = !!src.construction;
  return e;
}

/** The point a line ends at after a cut: an existing point there (shared,
 *  so coincident), or a new one kept on what cut the line. */
function linePointAt(sketch, cut, like, added) {
  if (cut.point) {
    // A sketch point on its own becomes the line's end (same id: its
    // relations and dimensions stay).
    if (sketch.entities.includes(cut.point)) detach(sketch, cut.point);
    return cut.point;
  }
  const p = new Point(cut.x, cut.y);
  if (cut.arcEnd) {
    added.push(tag(new C.ArcEndpointCoincidentConstraint(
      { arcId: cut.arcEnd.arc.id, centerId: cut.arcEnd.arc.center.id, which: cut.arcEnd.which }, p.id), like));
  } else if (cut.cutter instanceof Line) {
    added.push(tag(new C.PointOnLineConstraint(p.id, { a: cut.cutter.p1.id, b: cut.cutter.p2.id }), like));
  } else if (cut.cutter) {
    added.push(tag(new C.PointOnCircleConstraint(p.id, cut.cutter.id, cut.cutter.center.id), like));
  }
  return p;
}

/** Keeps an arc's (new) end on what cut it. */
function arcEndOn(cut, arc, which, added) {
  if (!cut) return;
  const ref = { arcId: arc.id, centerId: arc.center.id, which };
  if (cut.point) added.push(tag(new C.ArcEndpointCoincidentConstraint(ref, cut.point.id), arc));
  else if (cut.arcEnd) added.push(tag(new C.ArcEndpointArcEndpointCoincidentConstraint(ref,
    { arcId: cut.arcEnd.arc.id, centerId: cut.arcEnd.arc.center.id, which: cut.arcEnd.which }), arc));
  else if (cut.cutter instanceof Line) added.push(tag(new C.ArcEndpointOnLineConstraint(ref, { a: cut.cutter.p1.id, b: cut.cutter.p2.id }), arc));
  else if (cut.cutter) added.push(tag(new C.ArcEndpointOnCircleConstraint(ref, cut.cutter.id, cut.cutter.center.id), arc));
}

/** Removes `e` from the sketch without touching relations (they were
 *  moved already; pruneStale cleans what's left). */
const detach = (sketch, e) => { sketch.entities = sketch.entities.filter(x => x !== e); };

/* ---------------- trim ---------------- */

/**
 * Trims the piece of `e` under `at`.
 * @returns {{ removed: Entity[], added: Entity[], dropped: Constraint[], addedRelations: Constraint[], whole: boolean }}
 */
export function trimAt(sketch, e, at, opts = {}) {
  return trimPiece(sketch, pieceAt(sketch, e, at, opts));
}

export function trimPiece(sketch, piece) {
  const e = piece.e;
  const res = { removed: [], added: [], dropped: [], addedRelations: [], whole: false };
  const before = new Set(sketch.constraints);
  if (piece.whole) {
    sketch.removeEntity(e);
    res.removed.push(e);
    res.whole = true;
    res.dropped = [...before].filter(c => !sketch.constraints.includes(c));
    return res;
  }
  const added = [];
  if (e instanceof Line) {
    const P1 = e.p1, P2 = e.p2;
    if (!piece.lo) {                                   // from p1 to the first cut
      const q = linePointAt(sketch, piece.hi, e, added);
      e.p1 = q;
      res.dropped.push(...retargetLine(sketch, e, P1.id, P2.id, q.id, P2.id));
    } else if (!piece.hi) {                            // from the last cut to p2
      const q = linePointAt(sketch, piece.lo, e, added);
      e.p2 = q;
      res.dropped.push(...retargetLine(sketch, e, P1.id, P2.id, P1.id, q.id));
    } else {                                           // the middle: two lines
      const q1 = linePointAt(sketch, piece.lo, e, added);
      const q2 = linePointAt(sketch, piece.hi, e, added);
      e.p2 = q1;
      res.dropped.push(...retargetLine(sketch, e, P1.id, P2.id, P1.id, q1.id));
      const b = addLike(sketch, new Line(q2, P2), e);
      res.added.push(b);
      added.push(tag(new C.CollinearConstraint({ a: P1.id, b: q1.id }, { a: q2.id, b: P2.id }), e));
    }
  } else if (e instanceof Circle) {
    // keep the rest: counter-clockwise from hi round to lo, same id
    const arc = new Arc(e.center, e.r, piece.hi.u, piece.lo.u <= piece.hi.u ? piece.lo.u + TAU : piece.lo.u);
    const i = sketch.entities.indexOf(e);
    detach(sketch, e);
    arc.id = e.id;
    sketch.entities.splice(i, 0, arc);
    arc.sketchId = e.sketchId;
    arc.layerId = e.layerId; arc.style = e.style ? { ...e.style } : null; arc.construction = !!e.construction;
    arc.syncEnds();
    arcEndOn(piece.hi, arc, 'start', added);
    arcEndOn(piece.lo, arc, 'end', added);
    res.removed.push(e);
    res.added.push(arc);
  } else if (e instanceof Arc) {
    if (!piece.lo) {
      res.dropped.push(...arcEndRefs(sketch, e, 'start'));
      e.a0 = arcAngle(e, piece.hi.u);
      arcEndOn(piece.hi, e, 'start', added);
    } else if (!piece.hi) {
      res.dropped.push(...arcEndRefs(sketch, e, 'end'));
      e.a1 = arcAngle(e, piece.lo.u);
      arcEndOn(piece.lo, e, 'end', added);
    } else {
      const b = new Arc(e.center, e.r, arcAngle(e, piece.hi.u), e.a1);
      b.clockwise = !!e.clockwise;
      addLike(sketch, b, e);
      b.syncEnds();
      res.dropped.push(...arcEndRefs(sketch, e, 'end', b));
      e.a1 = arcAngle(e, piece.lo.u);
      arcEndOn(piece.lo, e, 'end', added);
      arcEndOn(piece.hi, b, 'start', added);
      added.push(tag(new C.EqualRadiusConstraint(e.id, b.id), e));
      res.added.push(b);
    }
    e.syncEnds();
  }
  sketch.constraints.push(...added);
  res.addedRelations = added;
  res.dropped.push(...pruneStale(sketch));
  res.addedRelations = res.addedRelations.filter(c => sketch.constraints.includes(c));
  return res;
}

/* ---------------- split ---------------- */

/** Nearest cut (intersection / point on the shape) to world point `at`
 *  within `snap` drawing units, else the projection of `at`. */
export function splitSpot(sketch, e, at, snap = 0, opts = {}) {
  const u = paramOf(e, at);
  const p = pointAt(e, u);
  let best = null, bd = snap;
  for (const c of findCuts(sketch, e, opts)) {
    const d = Math.hypot(c.x - at.x, c.y - at.y);
    if (d <= bd) { bd = d; best = c; }
  }
  if (best) return { ...best, snapped: 'cut' };
  if (!(e instanceof Circle)) {
    const m = pointAt(e, paramEnd(e) / 2);
    if (Math.hypot(m.x - at.x, m.y - at.y) <= snap) return { u: paramEnd(e) / 2, x: m.x, y: m.y, snapped: 'mid' };
  }
  return { u, x: p.x, y: p.y };
}

/** Can the shape be split at this spot (not on its own ends)? */
export function splittable(e, spot) {
  if (e instanceof Circle) return true;
  const s = paramScale(e) || 1;
  return spot.u * s > TRIM_TOL * 10 && (paramEnd(e) - spot.u) * s > TRIM_TOL * 10;
}

/**
 * Splits a line or an arc at `spot` (from splitSpot), or a circle at two
 * spots. The first piece keeps the shape's id and its relations.
 */
export function splitAt(sketch, e, spot, spot2 = null) {
  const res = { removed: [], added: [], dropped: [], addedRelations: [] };
  const added = [];
  if (e instanceof Line) {
    if (!splittable(e, spot)) return null;
    const P1 = e.p1, P2 = e.p2;
    const q = linePointAt(sketch, spot, e, added);
    e.p2 = q;
    res.dropped.push(...retargetLine(sketch, e, P1.id, P2.id, P1.id, q.id));
    const b = addLike(sketch, new Line(q, P2), e);
    res.added.push(b);
    added.push(tag(new C.CollinearConstraint({ a: P1.id, b: q.id }, { a: q.id, b: P2.id }), e));
  } else if (e instanceof Arc) {
    if (!splittable(e, spot)) return null;
    const b = new Arc(e.center, e.r, arcAngle(e, spot.u), e.a1);
    b.clockwise = !!e.clockwise;
    addLike(sketch, b, e);
    res.dropped.push(...arcEndRefs(sketch, e, 'end', b));
    e.a1 = arcAngle(e, spot.u);
    e.syncEnds(); b.syncEnds();
    // same centre; the joint gives the same radius too
    added.push(tag(new C.ArcEndpointArcEndpointCoincidentConstraint(
      { arcId: e.id, centerId: e.center.id, which: 'end' }, { arcId: b.id, centerId: b.center.id, which: 'start' }), e));
    if (spot.cutter || spot.point || spot.arcEnd) arcEndOn(spot, e, 'end', added);
    res.added.push(b);
  } else if (e instanceof Circle) {
    if (!spot2) return null;
    let u1 = spot.u, u2 = spot2.u;
    if (Math.abs(norm(u2 - u1)) * e.r < TRIM_TOL * 10 || Math.abs(norm(u1 - u2)) * e.r < TRIM_TOL * 10) return null;
    if (u2 <= u1) u2 += TAU;
    const a = new Arc(e.center, e.r, u1, u2);
    const i = sketch.entities.indexOf(e);
    detach(sketch, e);
    a.id = e.id;
    sketch.entities.splice(i, 0, a);
    a.sketchId = e.sketchId;
    a.layerId = e.layerId; a.style = e.style ? { ...e.style } : null; a.construction = !!e.construction;
    const b = new Arc(e.center, e.r, u2, u1 + TAU);
    addLike(sketch, b, a);
    a.syncEnds(); b.syncEnds();
    const ref = (arc, which) => ({ arcId: arc.id, centerId: arc.center.id, which });
    added.push(tag(new C.ArcEndpointArcEndpointCoincidentConstraint(ref(a, 'end'), ref(b, 'start')), a));
    added.push(tag(new C.ArcEndpointArcEndpointCoincidentConstraint(ref(b, 'end'), ref(a, 'start'), true), a));
    if (spot.cutter || spot.point || spot.arcEnd) arcEndOn(spot, a, 'start', added);
    if (spot2.cutter || spot2.point || spot2.arcEnd) arcEndOn(spot2, a, 'end', added);
    res.removed.push(e);
    res.added.push(a, b);
  } else return null;
  sketch.constraints.push(...added);
  res.addedRelations = added;
  res.dropped.push(...pruneStale(sketch));
  res.addedRelations = res.addedRelations.filter(c => sketch.constraints.includes(c));
  return res;
}

/* ---------------- power trim ---------------- */

/** Shapes the stroke a → b crosses, with where: [{ e, x, y }] in order along the stroke. */
export function strokeCrossings(sketch, a, b, ok = () => true) {
  const seg = new Line(new Point(a.x, a.y), new Point(b.x, b.y));
  const out = [];
  for (const e of sketch.entities) {
    if (!isCurve(e) || !ok(e)) continue;
    for (const p of crossings(e, seg)) out.push({ e, x: p.x, y: p.y, d: Math.hypot(p.x - a.x, p.y - a.y) });
  }
  return out.sort((p, q) => p.d - q.d);
}

import { Arc, Circle, Line, Point } from './entities.js';

/* =============== ARROWS =======================================
   An arrow is ink (in `sketch.strokes`, kind 'arrow') with two points:
   points[0] is the tail, points[1] the tip (where the drag ended, so the
   arrow points where you release, as in every drawing app).

   Saved: { kind: 'arrow', color, opacity, width, pts: [tailX, tailY, tipX, tipY],
            tips?: 'end' | 'both' | 'none'   (default 'end': a head at the tip)
            head?: 'filled' | 'open' | 'dot' (default 'filled')
            dash?: true
            at?:   [tailEnd, tipEnd] }       (each null or attached, below)

   Attached ends: drop an end on geometry (with Snap on) and it stays on
   it. The end is stored as a place on the geometry, not as coordinates:
     { to: point id }                    on a point (line end, centre…)
     { to: line id, t }                  at fraction t along a line
     { to: circle / arc id, a }          at angle a on the circle or arc
   so when a dimension moves the shape, the end moves with it and the
   arrow stretches (the other end stays where it is, or follows its own
   anchor). Dragging the whole arrow away detaches its ends; deleting the
   shape detaches the end and leaves it in place.

   Head size follows the line width: length 4.5 × width, half-width
   1.8 × width (never smaller than a readable minimum, in world units
   given by the caller).
   ============================================================ */

export const ARROW_TIPS = ['end', 'both', 'none'];
export const ARROW_HEADS = ['filled', 'open', 'dot'];

export const isArrow = (item) => !!item && item.kind === 'arrow';

/** Head length and half-width for a line width. */
export function headSize(width) {
  return { len: width * 4.5 + 0.0001, half: width * 1.8 };
}

/** Which ends carry a head: [tail, tip]. */
export function headedEnds(item) {
  const t = item.tips || 'end';
  return [t === 'both', t !== 'none'];
}

/** Attachment from a snap result of the snap engine, or null. */
export function attachFromSnap(snap) {
  if (!snap || !snap.entity) return null;
  const e = snap.entity;
  if (e instanceof Point) return { to: e.id };
  if (snap.kind === 'center' && (e instanceof Circle || e instanceof Arc)) return { to: e.center.id };
  if (e instanceof Line) {
    const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y, L2 = dx * dx + dy * dy;
    const t = L2 < 1e-18 ? 0.5 : ((snap.x - e.p1.x) * dx + (snap.y - e.p1.y) * dy) / L2;
    return { to: e.id, t: Math.min(1, Math.max(0, t)) };
  }
  if (e instanceof Circle || e instanceof Arc) {
    return { to: e.id, a: Math.atan2(snap.y - e.center.y, snap.x - e.center.x) };
  }
  return null;
}

/** World position of an attachment, or null when its geometry is gone. */
export function attachPoint(at, lookup) {
  const e = lookup.get(at.to);
  if (!e) return null;
  if (e instanceof Point) return { x: e.x, y: e.y };
  if (e instanceof Line) {
    const t = Number.isFinite(at.t) ? at.t : 0.5;
    return { x: e.p1.x + (e.p2.x - e.p1.x) * t, y: e.p1.y + (e.p2.y - e.p1.y) * t };
  }
  if (e instanceof Circle || e instanceof Arc) {
    const a = Number.isFinite(at.a) ? at.a : 0;
    return { x: e.center.x + e.r * Math.cos(a), y: e.center.y + e.r * Math.sin(a) };
  }
  return null;
}

/** Saved form of an attachment (or null). */
export function cleanAttach(at) {
  if (!at || typeof at !== 'object' || typeof at.to !== 'string' || !at.to) return null;
  const o = { to: at.to };
  if (Number.isFinite(Number(at.t))) o.t = Math.min(1, Math.max(0, Number(at.t)));
  else if (Number.isFinite(Number(at.a))) o.a = Number(at.a);
  return o;
}

/**
 * Moves attached arrow ends onto their geometry. Ends whose geometry is
 * gone are detached (they stay where they are). Arrows in `skip` (being
 * dragged by hand) are left alone.
 * @returns {boolean} whether anything changed
 */
export function syncArrowEnds(items, lookup, skip = null) {
  let changed = false;
  for (const it of items) {
    if (!isArrow(it) || !it.at || (skip && skip.has(it))) continue;
    for (let i = 0; i < 2; i++) {
      const at = it.at[i];
      if (!at) continue;
      const p = attachPoint(at, lookup);
      if (!p) { it.at[i] = null; changed = true; continue; }
      const q = it.points[i];
      if (Math.abs(q.x - p.x) > 1e-12 || Math.abs(q.y - p.y) > 1e-12) {
        it.points = it.points.map((pt, k) => (k === i ? p : pt));
        changed = true;
      }
    }
    if (!it.at[0] && !it.at[1]) { delete it.at; changed = true; }
  }
  return changed;
}

/** After arrows were moved by hand: ends that left their geometry are
 *  detached; ends that moved along with it (the shape was dragged too)
 *  stay attached. */
export function detachMovedEnds(items, lookup, tol = 1e-6) {
  for (const it of items) {
    if (!isArrow(it) || !it.at) continue;
    for (let i = 0; i < 2; i++) {
      const at = it.at[i];
      if (!at) continue;
      const p = attachPoint(at, lookup);
      const q = it.points[i];
      if (!p || Math.hypot(p.x - q.x, p.y - q.y) > tol * Math.max(1, Math.hypot(q.x, q.y))) it.at[i] = null;
    }
    if (!it.at[0] && !it.at[1]) delete it.at;
  }
}

/** Sets (or clears) the attachment of one end. */
export function setArrowEnd(item, end, at) {
  const list = item.at ? item.at.slice() : [null, null];
  list[end] = at ? cleanAttach(at) : null;
  if (list[0] || list[1]) item.at = list;
  else delete item.at;
}

/** Point at angle step (radians) from `from`, at the cursor's distance. */
export function constrainAngle(from, to, step = Math.PI / 12) {
  const dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + L * Math.cos(a), y: from.y + L * Math.sin(a) };
}

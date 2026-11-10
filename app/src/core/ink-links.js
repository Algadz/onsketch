import { Arc, Circle, Line, Point } from './entities.js';
import { inkBounds, isText, unionBounds } from './strokes.js';

/* =============== LINKED INK ====================================
   A stroke or a text can be linked to a point, a line, a circle or an
   arc. When the solver (a dimension, an equation, a drag) moves that
   geometry, the ink moves with it, like a label pinned to a part.

   Each anchor gives a frame (origin, direction, scale):
     point          origin at the point; no turning, no scaling
     line           origin at a fixed fraction t along the line (where
                    the ink sat when it was linked) and the line's
                    direction: ink slides with that spot and turns with
                    the line; a longer line spreads labels out
     circle / arc   origin at the centre, scaled by the radius: a ring
                    drawn around a hole grows with the hole
   The item keeps its world coordinates (so drawing, hit tests and the
   eraser need nothing special) plus the frame it was last placed in,
   `link.f = [ox, oy, ux, uy, s]`. Whenever the anchor's frame differs,
   the item is carried from the old frame to the new one. Text turns its
   position with a line but its letters stay upright.

   Saved: link { to: entity id, t?: fraction along a line, f: frame }.
   Deleting the anchor drops the link and leaves the ink where it is.
   ============================================================ */

const FRAME_EPS = 1e-9;

/** Kind of geometry ink can follow. */
export function canAnchor(e) {
  return e instanceof Point || e instanceof Line || e instanceof Circle || e instanceof Arc;
}

/** Fraction along a line of the projection of p, clamped to [0, 1]. */
export function lineFraction(line, p) {
  const a = line.p1, b = line.p2;
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  if (L2 < 1e-18) return 0.5;
  return Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
}

/** Current frame [ox, oy, ux, uy, s] of an anchor, or null. */
export function anchorFrame(e, t = 0.5) {
  if (e instanceof Point) return [e.x, e.y, 1, 0, 1];
  if (e instanceof Line) {
    const a = e.p1, b = e.p2;
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    const ox = a.x + dx * t, oy = a.y + dy * t;
    return L < 1e-12 ? [ox, oy, 1, 0, 1] : [ox, oy, dx / L, dy / L, 1];
  }
  if (e instanceof Circle || e instanceof Arc) return [e.center.x, e.center.y, 1, 0, Math.max(e.r, 1e-9)];
  return null;
}

function sameFrame(a, b) {
  for (let i = 0; i < 5; i++) if (Math.abs(a[i] - b[i]) > FRAME_EPS * Math.max(1, Math.abs(a[i]))) return false;
  return true;
}

/** Maps world points placed in frame `from` to frame `to`. */
export function frameMap(from, to) {
  const [ox0, oy0, ux0, uy0, s0] = from, [ox1, oy1, ux1, uy1, s1] = to;
  // rotation by (θ1 − θ0): cos = u0·u1, sin = u0×u1
  const c = ux0 * ux1 + uy0 * uy1, sn = ux0 * uy1 - uy0 * ux1;
  const k = s1 / s0;
  return (p) => {
    const dx = p.x - ox0, dy = p.y - oy0;
    return { x: ox1 + k * (c * dx - sn * dy), y: oy1 + k * (sn * dx + c * dy) };
  };
}

/** Moves one item from its stored frame to `frame`. A text moves its
 *  corner so the middle of its first line follows the frame; the letters
 *  keep their size and stay upright. */
function carry(item, frame) {
  const map = frameMap(item.link.f, frame);
  if (isText(item)) {
    const b = inkBounds(item);
    const p = item.points[0];
    const cx = (b.minX + b.maxX) / 2, cy = p.y - item.size * 0.6;
    const q = map({ x: cx, y: cy });
    item.points = [{ x: p.x + q.x - cx, y: p.y + q.y - cy }];
  } else {
    item.points = item.points.map(map);
  }
  item.link.f = frame;
}

/** Link items to an anchor. Items linked together share one position on
 *  a line (the middle of all of them), so they move as one piece. */
export function linkItems(items, anchor) {
  if (!items.length || !canAnchor(anchor)) return false;
  let t;
  if (anchor instanceof Line) {
    const b = unionBounds(items);
    t = lineFraction(anchor, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  }
  const f = anchorFrame(anchor, t);
  for (const it of items) {
    it.link = { to: anchor.id, f: f.slice() };
    if (t != null) it.link.t = t;
  }
  return true;
}

export function unlinkItems(items) {
  let n = 0;
  for (const it of items) if (it.link) { delete it.link; n++; }
  return n;
}

/** id → point / line / circle / arc, including line ends and centres. */
export function anchorLookup(sketches) {
  const map = new Map();
  for (const s of sketches) for (const e of s.entities) {
    map.set(e.id, e);
    for (const c of e.children()) if (!map.has(c.id)) map.set(c.id, c);
  }
  return map;
}

/**
 * Carries linked ink along with its anchors. Items whose anchor no
 * longer exists are unlinked (they stay where they are). Items in `skip`
 * (being dragged by hand) are left alone.
 * @returns {boolean} whether anything moved or was unlinked
 */
export function syncLinks(items, lookup, skip = null) {
  let changed = false;
  for (const it of items) {
    if (!it.link || (skip && skip.has(it))) continue;
    const anchor = lookup.get(it.link.to);
    const frame = anchor ? anchorFrame(anchor, it.link.t) : null;
    if (!frame) { delete it.link; changed = true; continue; }
    if (sameFrame(frame, it.link.f)) continue;
    carry(it, frame);
    changed = true;
  }
  return changed;
}

/** After ink was moved by hand: keep each item linked to the same
 *  anchor, from where it now is (items with one anchor are re-linked
 *  together, so a moved group keeps one shared spot on a line). */
export function rebaseLinks(items, lookup) {
  const byAnchor = new Map();
  for (const it of items) {
    if (!it.link) continue;
    if (!byAnchor.has(it.link.to)) byAnchor.set(it.link.to, []);
    byAnchor.get(it.link.to).push(it);
  }
  for (const [id, list] of byAnchor) {
    const a = lookup.get(id);
    if (a) linkItems(list, a);
    else unlinkItems(list);
  }
}

/* ---- Groups ---- */

/** Every item of the list in the same group as `item` (or just it). */
export function groupOf(items, item) {
  if (!item.group) return [item];
  return items.filter(x => x.group === item.group);
}

/** Expands a set of items to whole groups. */
export function withGroups(items, chosen) {
  const groups = new Set(chosen.map(x => x.group).filter(Boolean));
  if (!groups.size) return chosen.slice();
  const set = new Set(chosen);
  for (const x of items) if (x.group && groups.has(x.group)) set.add(x);
  return items.filter(x => set.has(x));
}

/**
 * Puts the items in one group. When the linked ones all follow the same
 * anchor, the unlinked ones are linked to it too, so the group moves as
 * one piece.
 */
export function groupItems(items, groupId, lookup) {
  if (items.length < 2) return false;
  for (const it of items) it.group = groupId;
  const anchors = new Set(items.filter(i => i.link).map(i => i.link.to));
  if (anchors.size === 1) {
    const a = lookup.get([...anchors][0]);
    if (a) linkItems(items, a);
  }
  return true;
}

export function ungroupItems(items) {
  let n = 0;
  for (const it of items) if (it.group) { delete it.group; n++; }
  return n;
}

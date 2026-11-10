import { isText, placeTextCenter, textCenter } from './strokes.js';

/* =============== RESIZING AND TURNING INK ======================
   Selected ink (strokes, arrows, texts, groups) can be scaled, turned
   and flipped as one piece. A transform is an affine map
     M = [a c e; b d f]:  (x, y) → (a x + c y + e, b x + d y + f)
   applied to a snapshot of the items taken when the gesture started, so
   a drag never accumulates rounding.

   - strokes and arrows: every point is mapped; the line width is scaled
     by √|det M| (the average scale), so a drawing keeps its look;
   - texts: the middle of the letters is mapped, the size is scaled by
     √|det M| and the angle turns with M. Letters are never stretched or
     mirrored: a flip moves a text to the mirrored place but keeps it
     readable.
   ============================================================ */

export const identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function apply(M, p) {
  return { x: M.a * p.x + M.c * p.y + M.e, y: M.b * p.x + M.d * p.y + M.f };
}

/** Scale by (sx, sy) about a fixed point. */
export function scaleAbout(o, sx, sy) {
  return { a: sx, b: 0, c: 0, d: sy, e: o.x - sx * o.x, f: o.y - sy * o.y };
}

/** Turn by `t` radians (counter-clockwise) about a fixed point. */
export function rotateAbout(o, t) {
  const c = Math.cos(t), s = Math.sin(t);
  return { a: c, b: s, c: -s, d: c, e: o.x - c * o.x + s * o.y, f: o.y - s * o.x - c * o.y };
}

/** The state of items a transform starts from. */
export function snapshot(items) {
  return items.map(it => ({
    it,
    points: it.points.map(p => ({ x: p.x, y: p.y })),
    width: it.width, size: it.size, angle: it.angle || 0,
  }));
}

/** Puts each item at M × its snapshot. */
export function applyTransform(snap, M) {
  const det = M.a * M.d - M.b * M.c;
  const k = Math.sqrt(Math.abs(det)) || 1e-9;
  const turn = det > 0 ? Math.atan2(M.b, M.a) : 0;
  for (const s of snap) {
    const it = s.it;
    if (isText(it)) {
      const c0 = textCenter({ ...it, points: s.points, size: s.size, angle: s.angle });
      it.size = s.size * k;
      const a = normAngle(s.angle + turn);
      if (Math.abs(a) < 1e-9) delete it.angle; else it.angle = a;
      placeTextCenter(it, apply(M, c0));
    } else {
      it.points = s.points.map(p => apply(M, p));
      if (s.width != null) it.width = s.width * k;
    }
  }
}

/** Puts items back as in their snapshot. */
export function restore(snap) {
  for (const s of snap) {
    s.it.points = s.points.map(p => ({ ...p }));
    if (s.width != null) s.it.width = s.width;
    if (s.size != null) s.it.size = s.size;
    if (s.angle) s.it.angle = s.angle; else delete s.it.angle;
  }
}

/** Angle in (−π, π]. */
export function normAngle(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Snaps an angle to multiples of `step`. */
export function snapAngle(a, step = Math.PI / 12) {
  return Math.round(a / step) * step;
}

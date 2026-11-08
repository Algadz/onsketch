/* =============== SKETCH STROKES ================================
   Freehand ink from the Sketch window (pen, marker). A stroke is a
   vector polyline in world units (mm), so it scales with zoom like ink
   on paper and survives export, undo and reload exactly.

   Strokes are free: the solver, dimensions, snapping and the Fill tool
   all ignore them. They belong to a layer like geometry does (visible,
   opacity, order, delete) and are drawn on top of that layer's shapes.

   Saved form:
     { id, layerId, kind: 'pen' | 'marker', color, opacity, width, pts: [x0, y0, x1, y1, …] }
   `width` is in world units; `pts` is a flat list of coordinates.
   ============================================================ */

export const STROKE_KINDS = ['pen', 'marker'];

const round = (v) => Math.round(v * 1000) / 1000;
const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Saved form of a stroke. */
export function strokeToJSON(s) {
  return {
    id: s.id, layerId: s.layerId, kind: s.kind, color: s.color,
    opacity: s.opacity, width: s.width,
    pts: s.points.flatMap(p => [round(p.x), round(p.y)]),
  };
}

/** Stroke from a file, or null when it isn't usable. */
export function reviveStroke(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.pts) || o.pts.length < 2) return null;
  const points = [];
  for (let i = 0; i + 1 < o.pts.length; i += 2) {
    const x = Number(o.pts[i]), y = Number(o.pts[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  if (!points.length) return null;
  const width = Number(o.width);
  const opacity = Number(o.opacity);
  return {
    id: typeof o.id === 'string' ? o.id : null,
    layerId: typeof o.layerId === 'string' ? o.layerId : null,
    kind: STROKE_KINDS.includes(o.kind) ? o.kind : 'pen',
    color: isHex(o.color) ? o.color : '#111418',
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.02, opacity)) : 1,
    width: Number.isFinite(width) && width > 0 ? width : 1,
    points,
  };
}

/** Ramer–Douglas–Peucker: drops points closer than `tol` to the line
 *  through their neighbours. Keeps the first and last point. */
export function simplifyPoints(points, tol) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = points[a], B = points[b];
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    let worst = -1, worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const P = points[i];
      let d;
      if (L2 < 1e-18) d = Math.hypot(P.x - A.x, P.y - A.y);
      else {
        const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2));
        d = Math.hypot(P.x - A.x - t * dx, P.y - A.y - t * dy);
      }
      if (d > worstD) { worst = i; worstD = d; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Distance from p to the stroke's centre line. */
export function distanceToStroke(stroke, p) {
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1], B = pts[i];
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2));
    const d = Math.hypot(p.x - A.x - t * dx, p.y - A.y - t * dy);
    if (d < best) best = d;
  }
  return best;
}

/** True when a circle of radius r at p touches the stroke's ink. */
export function strokeHit(stroke, p, r) {
  return distanceToStroke(stroke, p) <= r + stroke.width / 2;
}

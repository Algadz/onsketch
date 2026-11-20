/* =============== SHAPES: RECTANGLES, ELLIPSES, STARS… ==========
   Ready-made shapes from the Sketch window (Shapes tool, U): rectangle,
   rounded rectangle, ellipse, triangle, diamond, pentagon, hexagon, star,
   heart, speech bubble, check mark and cross. They are ink, like arrows
   and pictures: on a layer, never solved or dimensioned, and they don't
   close areas for the Fill tool.

     shape { id, layerId, kind: 'shape', shape, color, opacity, width,
             fill?, dash?, pts: [topLeft, topRight, bottomLeft] }

   The three points are a frame, as for a picture (core/images.js): the
   shape is drawn in the box they span, so moving, resizing, stretching,
   turning, flipping and following a linked shape all just map the three
   points. `width` is the outline width in drawing units. `fill`:
     (none)  outline only
     'tint'  the shape's colour, light (20 %)
     'solid' the shape's colour
     'paper' the canvas colour (masks what is behind, like a text box)
   `dash` draws a dashed outline. The check mark and the cross are lines
   only (never filled).
   ============================================================ */

export const SHAPES = [
  ['rect', 'Rectangle'], ['rounded', 'Rounded rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'],
  ['diamond', 'Diamond'], ['pentagon', 'Pentagon'], ['hexagon', 'Hexagon'], ['star', 'Star'],
  ['heart', 'Heart'], ['callout', 'Speech bubble'], ['check', 'Check mark'], ['cross', 'Cross'],
];
export const SHAPE_IDS = SHAPES.map(s => s[0]);
export const SHAPE_FILLS = ['none', 'tint', 'solid', 'paper'];
/** Lines only: never filled. */
export const OPEN_SHAPES = new Set(['check', 'cross']);
export const TINT = 0.2;

export const isShape = (item) => !!item && item.kind === 'shape';
export const shapeLabel = (id) => (SHAPES.find(s => s[0] === id) || [id, 'Shape'])[1];

const TAU = Math.PI * 2;

/** Points scaled to fill the unit box. */
function fit(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const w = x1 - x0 || 1, h = y1 - y0 || 1;
  return pts.map(p => ({ x: (p.x - x0) / w, y: (p.y - y0) / h }));
}

/** Regular polygon (or star) with a point at the top, fitted to the box. */
function regular(n, inner = 0) {
  const pts = [];
  const k = inner ? 2 * n : n;
  for (let i = 0; i < k; i++) {
    const a = -Math.PI / 2 + i * TAU / k, r = inner && i % 2 ? inner : 1;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return fit(pts);
}

/** Corner arcs of a rounded box (x0..x1, y0..y1 in the unit box, radii
 *  ru, rv), clockwise from the top-left; `bottom` adds points on the
 *  bottom edge (right to left) before the bottom-left corner. */
function roundedBox(x0, y0, x1, y1, ru, rv, bottom = []) {
  const pts = [];
  const arc = (cx, cy, a0) => { for (let i = 0; i <= 6; i++) { const a = a0 + i * Math.PI / 12; pts.push({ x: cx + Math.cos(a) * ru, y: cy + Math.sin(a) * rv }); } };
  arc(x0 + ru, y0 + rv, Math.PI);            // top-left (y down: π → 3π/2 goes up and right)
  arc(x1 - ru, y0 + rv, -Math.PI / 2);       // top-right
  arc(x1 - ru, y1 - rv, 0);                  // bottom-right
  pts.push(...bottom);
  arc(x0 + ru, y1 - rv, Math.PI / 2);        // bottom-left
  return pts;
}

/**
 * The shape in its unit box (x right, y down, 0..1), for a box of w × h
 * drawing units (rounded corners stay round when stretched).
 * @returns {{ pts: {x, y}[], closed: boolean }[]}
 */
export function unitPaths(shape, w = 1, h = 1) {
  const m = Math.min(Math.abs(w), Math.abs(h)) || 1;
  const ru = Math.min(0.5, (0.16 * m) / (Math.abs(w) || 1)), rv = Math.min(0.5, (0.16 * m) / (Math.abs(h) || 1));
  switch (shape) {
    case 'rounded': return [{ pts: roundedBox(0, 0, 1, 1, ru, rv), closed: true }];
    case 'ellipse': {
      const pts = [];
      for (let i = 0; i < 72; i++) { const a = i * TAU / 72; pts.push({ x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) }); }
      return [{ pts, closed: true }];
    }
    case 'triangle': return [{ pts: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true }];
    case 'diamond': return [{ pts: [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }], closed: true }];
    case 'pentagon': return [{ pts: regular(5), closed: true }];
    case 'hexagon': return [{ pts: regular(6), closed: true }];
    case 'star': return [{ pts: regular(5, 0.4), closed: true }];
    case 'heart': {
      const pts = [];
      for (let i = 0; i < 80; i++) {
        const t = i * TAU / 80, s = Math.sin(t);
        pts.push({ x: 16 * s * s * s, y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) });
      }
      return [{ pts: fit(pts), closed: true }];
    }
    case 'callout': {
      const yb = 0.78, rv2 = Math.min(rv, yb / 2);
      const tail = [{ x: 0.42, y: yb }, { x: 0.16, y: 1 }, { x: 0.24, y: yb }];
      return [{ pts: roundedBox(0, 0, 1, yb, ru, rv2, tail), closed: true }];
    }
    case 'check': return [{ pts: [{ x: 0, y: 0.55 }, { x: 0.36, y: 0.95 }, { x: 1, y: 0.05 }], closed: false }];
    case 'cross': return [
      { pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false },
      { pts: [{ x: 1, y: 0 }, { x: 0, y: 1 }], closed: false },
    ];
    default: return [{ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true }];
  }
}

/** Width and height of the frame, in drawing units. */
export function shapeSize(item) {
  const [a, b, c] = item.points;
  return { w: Math.hypot(b.x - a.x, b.y - a.y), h: Math.hypot(c.x - a.x, c.y - a.y) };
}

/** The four world corners of the frame, clockwise from the top-left. */
export function shapeCorners(item) {
  const [a, b, c] = item.points;
  return [a, b, { x: b.x + c.x - a.x, y: b.y + c.y - a.y }, c];
}

/** The shape's outline(s) in world units. */
export function shapePaths(item) {
  const [a, b, c] = item.points;
  const { w, h } = shapeSize(item);
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - a.x, vy = c.y - a.y;
  return unitPaths(item.shape, w, h).map(p => ({
    closed: p.closed,
    pts: p.pts.map(q => ({ x: a.x + q.x * ux + q.y * vx, y: a.y + q.x * uy + q.y * vy })),
  }));
}

/** Whether the shape is drawn filled. */
export const shapeFilled = (item) => !!item.fill && item.fill !== 'none' && !OPEN_SHAPES.has(item.shape);

function segDist(p, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2));
  return Math.hypot(p.x - A.x - t * dx, p.y - A.y - t * dy);
}

function inside(p, pts) {
  let on = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const A = pts[i], B = pts[j];
    if ((A.y > p.y) !== (B.y > p.y) && p.x < (B.x - A.x) * (p.y - A.y) / (B.y - A.y) + A.x) on = !on;
  }
  return on;
}

/** True when a circle of radius r at p touches the shape: its outline,
 *  or anywhere inside a filled one. */
export function shapeHit(item, p, r) {
  const paths = shapePaths(item);
  const reach = r + (item.width || 0) / 2;
  for (const path of paths) {
    const n = path.pts.length;
    for (let i = 0; i + 1 < n; i++) if (segDist(p, path.pts[i], path.pts[i + 1]) <= reach) return true;
    if (path.closed && n > 2 && segDist(p, path.pts[n - 1], path.pts[0]) <= reach) return true;
    if (path.closed && shapeFilled(item) && inside(p, path.pts)) return true;
  }
  return false;
}

/**
 * Frame for a shape dragged from `a` to `b` (world, y up).
 * @param {boolean} square  equal sides (Shift)
 * @param {boolean} center  `a` is the middle (Ctrl)
 */
export function shapeFrame(a, b, { square = false, center = false } = {}) {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (square) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
  const x0 = center ? a.x - Math.abs(dx) : Math.min(a.x, a.x + dx), x1 = center ? a.x + Math.abs(dx) : Math.max(a.x, a.x + dx);
  const y0 = center ? a.y - Math.abs(dy) : Math.min(a.y, a.y + dy), y1 = center ? a.y + Math.abs(dy) : Math.max(a.y, a.y + dy);
  return [{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: x0, y: y0 }];
}

/** A small SVG of a shape (its button in the Sketch window). */
export function shapeGlyph(shape, size = 18) {
  const pad = 2, s = size - pad * 2;
  const d = unitPaths(shape, 1, shape === 'callout' ? 0.85 : 1).map(p =>
    p.pts.map((q, i) => `${i ? 'L' : 'M'}${(pad + q.x * s).toFixed(2)} ${(pad + q.y * s).toFixed(2)}`).join('') + (p.closed ? 'Z' : '')).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

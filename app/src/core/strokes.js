/* =============== SKETCH INK: STROKES AND TEXT ==================
   Ink from the Sketch window: freehand strokes (pen, marker) and text.
   Everything is vector, in world units (mm), so it scales with zoom like
   ink on paper and survives export, undo and reload exactly.

   Ink is free: the solver, dimensions, snapping and the Fill tool all
   ignore it. It belongs to a layer like geometry does (visible, opacity,
   order, delete) and is drawn on top of that layer's shapes.

   Saved form (one list, `sketch.strokes`, in drawing order):
     stroke { id, layerId, kind: 'pen' | 'marker', color, opacity, width, pts: [x0, y0, x1, y1, …] }
     text   { id, layerId, kind: 'text', color, opacity, size, text, bold?, box?, pts: [x, y] }
   plus, on any item:
     group  'g12'          items with the same group select and move together
     link   { to, t?, f }  follows a point / line / circle / arc (core/ink-links.js)
   `width` and `size` are in world units; `pts` is a flat list of
   coordinates. A text's point is the top-left corner of its first line;
   `size` is the letter height (font size), lines are 1.25 × size apart.

   Text box: `box: { color, border? }` draws an opaque rounded box behind
   the text (padding 0.35 × size), so a label stays readable over lines
   and fills. `color` is a hex colour or 'paper' (the canvas colour: white
   on the light theme, dark on the dark one, or the background colour set
   with the Fill tool), so the default box masks what's behind it in both
   themes. `border` outlines the box in the text colour.
   ============================================================ */

export const STROKE_KINDS = ['pen', 'marker'];
export const INK_KINDS = ['pen', 'marker', 'text'];

/** Font used for text, on the canvas and in the inline editor. */
export const TEXT_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const TEXT_LINE = 1.25;
export const TEXT_MAX = 2000;
/** Box padding around a text, in multiples of its size. */
export const BOX_PAD = 0.35;
export const PAPER = 'paper';
/** Box colours offered in the UI: paper, then light tints. */
export const BOX_COLORS = [PAPER, '#fff3b0', '#dbeafe', '#dcfce7', '#fde2e4', '#ede9fe'];

const round = (v) => Math.round(v * 1000) / 1000;
const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

export const isText = (item) => !!item && item.kind === 'text';

/** CSS font for a text item at `px` pixels. */
export function textFont(px, bold) {
  return `${bold ? '600 ' : ''}${px}px ${TEXT_FONT}`;
}

/** Saved form of a stroke or a text. */
export function strokeToJSON(s) {
  const o = {
    id: s.id, layerId: s.layerId, kind: s.kind, color: s.color, opacity: s.opacity,
  };
  if (isText(s)) {
    o.size = s.size;
    o.text = s.text;
    if (s.bold) o.bold = true;
    if (s.box) o.box = s.box.border ? { color: s.box.color, border: true } : { color: s.box.color };
  } else o.width = s.width;
  o.pts = s.points.flatMap(p => [round(p.x), round(p.y)]);
  if (s.group) o.group = s.group;
  if (s.link) o.link = linkToJSON(s.link);
  return o;
}

function linkToJSON(l) {
  // Full precision: the frame must match the anchor exactly after a reload,
  // or the ink would creep on every undo.
  const o = { to: l.to, f: l.f.slice() };
  if (Number.isFinite(l.t)) o.t = l.t;
  return o;
}

function reviveLink(l) {
  if (!l || typeof l !== 'object' || typeof l.to !== 'string' || !Array.isArray(l.f) || l.f.length !== 5) return null;
  const f = l.f.map(Number);
  if (!f.every(Number.isFinite) || !(f[4] > 0)) return null;
  const o = { to: l.to, f };
  if (Number.isFinite(Number(l.t))) o.t = Math.min(1, Math.max(0, Number(l.t)));
  return o;
}

/** Stroke or text from a file, or null when it isn't usable. */
export function reviveStroke(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.pts) || o.pts.length < 2) return null;
  const points = [];
  for (let i = 0; i + 1 < o.pts.length; i += 2) {
    const x = Number(o.pts[i]), y = Number(o.pts[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  if (!points.length) return null;
  const opacity = Number(o.opacity);
  const base = {
    id: typeof o.id === 'string' ? o.id : null,
    layerId: typeof o.layerId === 'string' ? o.layerId : null,
    color: isHex(o.color) ? o.color : '#111418',
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.02, opacity)) : 1,
  };
  if (typeof o.group === 'string' && o.group) base.group = o.group;
  const link = reviveLink(o.link);
  if (link) base.link = link;
  if (o.kind === 'text') {
    const text = typeof o.text === 'string' ? o.text.slice(0, TEXT_MAX) : '';
    const size = Number(o.size);
    if (!text.trim()) return null;
    const t = { ...base, kind: 'text', text, size: Number.isFinite(size) && size > 0 ? size : 5, bold: !!o.bold, points: [points[0]] };
    const box = cleanBox(o.box);
    if (box) t.box = box;
    return t;
  }
  const width = Number(o.width);
  return {
    ...base,
    kind: STROKE_KINDS.includes(o.kind) ? o.kind : 'pen',
    width: Number.isFinite(width) && width > 0 ? width : 1,
    points,
  };
}

/** A usable text box, or null. */
export function cleanBox(b) {
  if (!b || typeof b !== 'object') return null;
  const color = b.color === PAPER || isHex(b.color) ? b.color : PAPER;
  return b.border ? { color, border: true } : { color };
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

/* ---- Text measuring ----
   Widths are measured once per line and font weight at 100 px with a
   canvas context (the browser), in "em" (multiples of the font size), so
   bounds don't depend on zoom. Without a canvas (unit tests) an average
   glyph width is used. */
let measureCtx;
const widthCache = new Map();
function measureEm(line, bold) {
  const key = (bold ? 'b' : 'r') + line;
  let w = widthCache.get(key);
  if (w != null) return w;
  if (measureCtx === undefined) {
    measureCtx = null;
    try {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4)
        : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
      measureCtx = c ? c.getContext('2d') : null;
    } catch { measureCtx = null; }
  }
  if (measureCtx) {
    measureCtx.font = textFont(100, bold);
    w = measureCtx.measureText(line).width / 100;
  } else w = line.length * (bold ? 0.6 : 0.56);
  if (widthCache.size > 4000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

export function textLines(item) { return String(item.text ?? '').split('\n'); }

/** Width and height of a text, in world units. */
export function textBox(item) {
  const lines = textLines(item);
  const w = Math.max(0.3, ...lines.map(l => measureEm(l, item.bold))) * item.size;
  return { w, h: lines.length * item.size * TEXT_LINE };
}

/** World box of a text's letters (without its box). */
export function textBounds(item) {
  const p = item.points[0], b = textBox(item);
  return { minX: p.x, maxX: p.x + b.w, minY: p.y - b.h, maxY: p.y };
}

/** World bounding box of a stroke (with its width) or a text (with its
 *  box, when it has one). */
export function inkBounds(item) {
  if (isText(item)) {
    const b = textBounds(item);
    if (!item.box) return b;
    const m = item.size * BOX_PAD;
    return { minX: b.minX - m, maxX: b.maxX + m, minY: b.minY - m, maxY: b.maxY + m };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of item.points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  const h = (item.width || 0) / 2;
  return { minX: minX - h, minY: minY - h, maxX: maxX + h, maxY: maxY + h };
}

/** Bounding box of several ink items, or null. */
export function unionBounds(items) {
  let b = null;
  for (const it of items) {
    const k = inkBounds(it);
    if (!b) b = { ...k };
    else { b.minX = Math.min(b.minX, k.minX); b.minY = Math.min(b.minY, k.minY); b.maxX = Math.max(b.maxX, k.maxX); b.maxY = Math.max(b.maxY, k.maxY); }
  }
  return b;
}

/** True when a circle of radius r at p touches the item: a stroke's ink,
 *  or anywhere in a text's box. */
export function inkHit(item, p, r) {
  if (!isText(item)) return strokeHit(item, p, r);
  const b = inkBounds(item);
  return p.x >= b.minX - r && p.x <= b.maxX + r && p.y >= b.minY - r && p.y <= b.maxY + r;
}

/** True when the item lies entirely inside the world box. */
export function inkInBox(item, x0, y0, x1, y1) {
  if (isText(item)) {
    const b = inkBounds(item);
    return b.minX >= x0 && b.maxX <= x1 && b.minY >= y0 && b.maxY <= y1;
  }
  return item.points.every(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);
}

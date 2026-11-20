
/* =============== SIZES =========================================
   Ink sizes are on the drawing, in the document unit (project.sizes):
     pen     freehand pen width
     marker  highlighter width
     arrow   arrow line width (heads scale with it)
     text    text height (letter size)
   A 5 mm text is 5 mm at every zoom; the size you pick doesn't depend on
   the zoom you are at. Each is first set from the view (what the old pixel
   default looked like at that zoom), rounded, then stays put.

   The CAD line weight (lines, circles, arcs, curves) is one setting for
   the whole sketch, in screen pixels AT 100 % ZOOM (project.sizes.linePx):
   1.4 px is 1.4 px at 100 %, 2.8 px at 200 %, 0.7 px at 50 % — it zooms
   with the drawing (never thinner than a hairline, so nothing vanishes).
   Shapes keep only their line type.

   The eraser stays a cursor size in screen pixels; dimensions, handles and
   markers are editor overlays and stay in pixels too.
   ============================================================ */

/** Screen px per drawing unit at 100 % zoom (the status bar shows zoom × 25 %). */
export const ZOOM_100 = 4;
export const DEFAULT_LINE_PX = 1.4;

/** Ink sizes, in drawing units. */
export const SIZE_KEYS = ['pen', 'marker', 'arrow', 'text'];
/** Screen pixels the ink defaults looked like (used to pick a first size). */
export const SIZE_PX = { pen: 3, marker: 18, arrow: 2, text: 18 };
export const SIZE_LABELS = { linePx: 'Line weight', pen: 'Pen size', marker: 'Marker size', arrow: 'Arrow size', text: 'Text size' };
/** Never thinner than this on screen. */
export const MIN_LINE_PX = 0.75;

/** A round number near v: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k. */
export function niceSize(v) {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const k = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / k;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  let best = steps[0];
  for (const s of steps) if (Math.abs(Math.log(s / m)) < Math.abs(Math.log(best / m))) best = s;
  return Number((best * k).toPrecision(3));
}

/** The next size up / down (arrow keys in the size fields). */
export function stepSize(v, up) {
  const k = up ? 1.25 : 1 / 1.25;
  const n = niceSize(v * k);
  return n === v ? niceSize(v * k * k) : n;
}

export function cleanSizes(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of [...SIZE_KEYS, 'linePx', 'line']) { const v = Number(o[k]); if (Number.isFinite(v) && v > 0) out[k] = v; }
  return Object.keys(out).length ? out : null;
}

/** Fills the document's missing sizes from the view (zoom = screen px per
 *  drawing unit). @returns {object} project.sizes */
export function ensureSizes(project, zoom) {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 4;
  project.sizes ||= {};
  for (const k of SIZE_KEYS) if (!(project.sizes[k] > 0)) project.sizes[k] = niceSize(SIZE_PX[k] / z);
  if (!(project.sizes.linePx > 0)) project.sizes.linePx = DEFAULT_LINE_PX;
  return project.sizes;
}

/** Screen px a line of the sketch is drawn with at this zoom. */
export function linePxAt(linePx, zoom) {
  return Math.max(MIN_LINE_PX, (linePx > 0 ? linePx : DEFAULT_LINE_PX) * zoom / ZOOM_100);
}

const roundPx = (v) => Math.max(0.1, Math.round(v * 10) / 10);

/** One line weight for the whole sketch, in px at 100 % zoom. Shapes saved
 *  with weights of their own give them up; the sketch takes the most
 *  common one: from pixels in older files (`pixels`), from drawing units
 *  (× px per unit at 100 %) in files of the last versions, as was a
 *  sketch-wide `line` in drawing units. */
export function sketchWideLineWeight(project, { pixels = false } = {}) {
  const count = new Map();
  for (const s of project.sketches) for (const e of s.entities) {
    const w = e.style?.lineWidth;
    if (!(w > 0)) continue;
    count.set(w, (count.get(w) || 0) + 1);
    delete e.style.lineWidth;
    if (!Object.keys(e.style).length) delete e.style;
  }
  const sizes = project.sizes ||= {};
  if (!(sizes.linePx > 0)) {
    const common = count.size ? [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : null;
    if (pixels) sizes.linePx = roundPx(common ?? DEFAULT_LINE_PX);
    else if (common != null) sizes.linePx = roundPx(common * ZOOM_100);
    else if (sizes.line > 0) sizes.linePx = roundPx(sizes.line * ZOOM_100);
  }
  delete sizes.line;
}

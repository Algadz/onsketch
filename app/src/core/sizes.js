import { Arc, Bezier, Circle, Line, Point } from './entities.js';

/* =============== SIZES IN DRAWING UNITS ========================
   Line weights, pen and marker widths, arrow widths and text heights are
   sizes ON THE DRAWING, in the document unit, like everything else: a
   0.35 mm line is 0.35 mm at every zoom, prints 0.35 mm at 1:1 and
   0.0035 mm at 1:100… Zooming in makes it thicker on screen, as on paper
   (never thinner than a hairline, so nothing vanishes when zoomed out).

   Each document keeps its sizes (project.sizes, saved with it):
     line    weight of new lines, circles, arcs, curves
     pen     freehand pen width
     marker  highlighter width
     arrow   arrow line width (heads scale with it)
     text    text height (letter size)
   A size is first set from the view (what the old pixel default looked
   like at the zoom then), rounded to a round number in the document
   unit, and stays put from then on whatever the zoom. The eraser stays a
   cursor size in screen pixels; dimensions, handles and markers are
   editor overlays and stay in pixels too.

   Files saved before had line weights in screen pixels: they are turned
   into drawing units at the zoom that fits the drawing, so they open
   looking as they did.
   ============================================================ */

export const SIZE_KEYS = ['line', 'pen', 'marker', 'arrow', 'text'];
/** Screen pixels the defaults looked like (used to pick a first size). */
export const SIZE_PX = { line: 1.4, pen: 3, marker: 18, arrow: 2, text: 18 };
export const SIZE_LABELS = { line: 'Weight', pen: 'Pen size', marker: 'Marker size', arrow: 'Arrow size', text: 'Text size' };
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
  for (const k of SIZE_KEYS) { const v = Number(o[k]); if (Number.isFinite(v) && v > 0) out[k] = v; }
  return Object.keys(out).length ? out : null;
}

/** Fills the document's missing sizes from the view (zoom = screen px per
 *  drawing unit). @returns {object} project.sizes */
export function ensureSizes(project, zoom) {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 4;
  project.sizes ||= {};
  for (const k of SIZE_KEYS) if (!(project.sizes[k] > 0)) project.sizes[k] = niceSize(SIZE_PX[k] / z);
  return project.sizes;
}

/** Screen px per drawing unit when the drawing fills about 1100 px
 *  (Zoom to fit on a common screen). */
export function fitZoom(project) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (p) => { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; };
  for (const s of project.sketches) for (const e of s.entities) {
    if (e instanceof Line) { acc(e.p1); acc(e.p2); }
    else if (e instanceof Circle || e instanceof Arc) { acc({ x: e.center.x - e.r, y: e.center.y - e.r }); acc({ x: e.center.x + e.r, y: e.center.y + e.r }); }
    else if (e instanceof Bezier) { for (const p of e.ctrl()) acc(p); }
    else if (e instanceof Point) acc(e);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (!(span > 1e-9) || !Number.isFinite(span)) return 4;
  return Math.min(5000, Math.max(1e-7, 1100 / span));
}

/** Files from before: line weights were screen pixels. Turn them (and the
 *  default for shapes without one) into drawing units at the zoom that fits
 *  the drawing. */
export function migratePixelLineWidths(project) {
  const z = fitZoom(project);
  const toUnits = (px) => niceSize(px / z);
  for (const s of project.sketches) for (const e of s.entities) {
    if (e instanceof Point) continue;
    e.style ||= {};
    e.style.lineWidth = toUnits(Number.isFinite(e.style.lineWidth) && e.style.lineWidth > 0 ? e.style.lineWidth : SIZE_PX.line);
  }
  project.sizes = { ...(project.sizes || {}), line: toUnits(SIZE_PX.line) };
  return z;
}

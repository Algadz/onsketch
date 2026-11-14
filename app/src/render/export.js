import { Arc, Circle, Line, Point } from '../core/entities.js';
import { inkBounds } from '../core/strokes.js';
import { Renderer } from './renderer.js';
import { SvgContext } from './svg-context.js';
import { View } from './view.js';

/* =============== EXPORT: THE DRAWING AS A PICTURE ===============
   Draws the project for showing rather than editing, with the same
   renderer as the screen: fills, shapes in ink (no state colours, no
   end-point dots), ink, text, arrows, pictures and, when asked,
   dimensions. No grid, relations, selection or hover. Light theme.

   exportPNG(...)   → canvas (2× for sharp slides)
   exportSVG(...)   → SVG text, sized in px (the drawing fitted)
   exportPrintSVG(...) → SVG text for one sheet of paper at a true scale
                         (1:1, 1:2, 1:5…), with a title line and a
                         check length to verify the print

   `src` is what the editor knows beyond the project:
     { project, fillDisplay, labelFor, layerState, redundantIds }
   Options: { dimensions, construction, transparent }.
   ============================================================ */
export const PX_PER_MM = 96 / 25.4;
export const PAPERS = { A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4] };
export const SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
const PRINT_MARGIN = 10;            // mm, each side
const PRINT_FOOTER = 9;             // mm, title line at the bottom

/** Bounding box of what an export shows, in world units, or null. */
export function exportBounds(project, { construction = false } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  const active = project.active();
  for (const s of project.sketches) {
    if (s.visible === false) continue;
    for (const e of s.entities) {
      if (project.layerOf(e)?.visible === false) continue;
      if (e.construction && !construction) continue;
      if (e instanceof Line) { acc(e.p1.x, e.p1.y); acc(e.p2.x, e.p2.y); }
      else if (e instanceof Circle || e instanceof Arc) { acc(e.center.x - e.r, e.center.y - e.r); acc(e.center.x + e.r, e.center.y + e.r); }
      else if (e instanceof Point) acc(e.x, e.y);
    }
    if (s !== active) continue;                     // ink is drawn for the active sketch
    for (const st of s.strokes || []) {
      if (project.layer(st.layerId)?.visible === false) continue;
      const b = inkBounds(st);
      acc(b.minX, b.minY); acc(b.maxX, b.maxY);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** Runs `fn` with selection and hover hidden, then puts them back. */
function withoutEditorState(project, fn) {
  const flags = [];
  const hide = (x) => { if (x.hover || x.selected) { flags.push([x, x.hover, x.selected]); x.hover = false; x.selected = false; } };
  for (const s of project.sketches) {
    for (const e of s.entities) { hide(e); for (const c of e.children()) hide(c); }
    for (const st of s.strokes || []) hide(st);
    for (const c of s.constraints || []) hide(c);
  }
  try { return fn(); }
  finally { for (const [x, h, sel] of flags) { x.hover = h; x.selected = sel; } }
}

/** Paints the drawing on `ctx` (a canvas 2D context or an SvgContext). */
function paint(ctx, view, src, opts) {
  const { project } = src;
  const r = new Renderer({ getContext: () => ctx }, view);
  r.dpr = 1;
  r.exportMode = { construction: !!opts.construction };
  if (src.labelFor) r.labelFor = src.labelFor;
  return withoutEditorState(project, () => {
    r.background = opts.transparent ? null : project.background;
    if (!opts.transparent && opts.backdrop !== false) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, view.cssW, view.cssH);
      if (project.background) { ctx.fillStyle = project.background; ctx.fillRect(0, 0, view.cssW, view.cssH); }
      ctx.restore();
    }
    r.drawEntities(project, src.fillDisplay || new Map());
    const sketch = project.active();
    if (opts.dimensions && sketch) {
      const entMap = new Map();
      const walk = (e) => { entMap.set(e.id, e); for (const c of e.children()) walk(c); };
      for (const s of project.visibleSketches()) for (const e of s.entities) walk(e);
      r.drawDimensions(sketch, entMap, src.redundantIds, src.layerState || (() => 'active'));
    }
    return r;
  });
}

function measureContext() {
  return typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
}

/** With dimensions shown, their labels can sit outside the shapes: draw
 *  once (no pixels) to find them and grow the box to hold them. */
function boundsWithDimensions(src, opts, bounds, view) {
  if (!opts.dimensions) return bounds;
  const r = paint(new SvgContext(view.cssW, view.cssH, measureContext()), view, src, { ...opts, backdrop: false });
  const b = { ...bounds };
  for (const d of r.lastDimRects || []) {
    for (const [x, y] of [[d.x, d.y], [d.x + d.w, d.y + d.h]]) {
      const w = view.screenToWorld({ x, y });
      b.minX = Math.min(b.minX, w.x); b.maxX = Math.max(b.maxX, w.x);
      b.minY = Math.min(b.minY, w.y); b.maxY = Math.max(b.maxY, w.y);
    }
  }
  return b;
}

function fittedView(bounds, maxSide, pad) {
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
  const view = new View();
  const room = maxSide - 2 * pad;
  view.zoom = w < 1e-9 && h < 1e-9 ? 4 : Math.min(room / Math.max(w, 1e-9), room / Math.max(h, 1e-9), 5000);
  view.cssW = Math.max(160, Math.ceil(w * view.zoom + 2 * pad));
  view.cssH = Math.max(120, Math.ceil(h * view.zoom + 2 * pad));
  view.panX = -((bounds.minX + bounds.maxX) / 2) * view.zoom;
  view.panY = ((bounds.minY + bounds.maxY) / 2) * view.zoom;
  return view;
}

/** The view an image export uses: everything fitted, the long side at
 *  most `maxSide` px, or null when there is nothing to show. */
export function exportView(src, opts = {}, { maxSide = 1200, pad = 36 } = {}) {
  const bounds = exportBounds(src.project, opts);
  if (!bounds) return null;
  let view = fittedView(bounds, maxSide, pad);
  // Twice: labels keep their size on screen, so growing the box moves them.
  for (let i = 0; i < 2 && opts.dimensions; i++) view = fittedView(boundsWithDimensions(src, opts, bounds, view), maxSide, pad);
  return view;
}

/** @returns {HTMLCanvasElement | null} */
export function exportPNG(src, opts = {}, { scale = 2 } = {}) {
  const view = exportView(src, opts);
  if (!view) return null;
  const k = Math.min(scale, 4096 / Math.max(view.cssW, view.cssH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(view.cssW * k); canvas.height = Math.round(view.cssH * k);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  paint(ctx, view, src, opts);
  return canvas;
}

/** @returns {string | null} */
export function exportSVG(src, opts = {}) {
  const view = exportView(src, opts);
  if (!view) return null;
  const ctx = new SvgContext(view.cssW, view.cssH, measureContext());
  paint(ctx, view, src, opts);
  return ctx.toSVG({ title: src.project.name || 'OnSketch' });
}

/** Paper size in mm for a drawing of w × h mm at 1 : scale, turned the
 *  way the drawing lies. */
export function paperFor(paper, w, h) {
  const [a, b] = PAPERS[paper] || PAPERS.A4;
  return w > h ? { pw: b, ph: a, landscape: true } : { pw: a, ph: b, landscape: false };
}
/** Room for the drawing on that sheet, in mm. */
export function printableArea({ pw, ph }) {
  return { w: pw - 2 * PRINT_MARGIN, h: ph - 2 * PRINT_MARGIN - PRINT_FOOTER };
}
/** Largest standard scale (smallest N of 1 : N) at which the drawing
 *  fits on the sheet. */
export function bestScale(paper, w, h) {
  const area = printableArea(paperFor(paper, w, h));
  for (const n of SCALES) if (w / n <= area.w + 1e-6 && h / n <= area.h + 1e-6) return n;
  return SCALES[SCALES.length - 1];
}

/** Where the drawing goes on one sheet at a true scale: the sheet, the
 *  scale 1 : n (the largest standard one that fits when none is given),
 *  the drawing's size in world mm (dimension labels included) and
 *  whether it fits. Null when there is nothing to show. */
export function printLayout(src, opts = {}, { paper = 'A4', scale = null } = {}) {
  const shapes = exportBounds(src.project, opts);
  if (!shapes) return null;
  // Size the sheet on what is drawn, dimension labels included.
  let bounds = boundsWithDimensions(src, opts, shapes, fittedView(shapes, 1200, 36));
  const size = () => ({ w: bounds.maxX - bounds.minX, h: bounds.maxY - bounds.minY });
  let { w, h } = size();
  const n = scale || bestScale(paper, w, h);
  const sheet = paperFor(paper, w, h);
  const view = new View();
  view.cssW = sheet.pw * PX_PER_MM; view.cssH = sheet.ph * PX_PER_MM;
  view.zoom = PX_PER_MM / n;
  const place = () => {
    view.panX = -((bounds.minX + bounds.maxX) / 2) * view.zoom;
    view.panY = ((bounds.minY + bounds.maxY) / 2) * view.zoom - (PRINT_FOOTER / 2) * PX_PER_MM;
  };
  place();
  // Labels keep their size on paper: measure again at the real scale.
  if (opts.dimensions) { bounds = boundsWithDimensions(src, opts, shapes, view); ({ w, h } = size()); place(); }
  const area = printableArea(sheet);
  return { view, sheet, n, w, h, area, fits: w / n <= area.w + 1e-6 && h / n <= area.h + 1e-6 };
}

/** One sheet at a true scale. @returns {{ svg, pw, ph, landscape, fits, scale } | null} */
export function exportPrintSVG(src, opts = {}, { paper = 'A4', scale = null } = {}) {
  const layout = printLayout(src, opts, { paper, scale });
  if (!layout) return null;
  const { view, sheet, n, fits } = layout;

  const ctx = new SvgContext(view.cssW, view.cssH, measureContext());
  paint(ctx, view, src, { ...opts, transparent: false });
  // Title line: name, scale, and a length to check the print against.
  const mm = PX_PER_MM, y = (sheet.ph - PRINT_MARGIN) * mm, x0 = PRINT_MARGIN * mm;
  const check = [100, 50, 20, 10].find(len => len <= sheet.pw / 3) || 10;
  ctx.save();
  ctx.fillStyle = '#111418'; ctx.strokeStyle = '#111418'; ctx.lineWidth = 1;
  ctx.font = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillText(`${src.project.name || 'Untitled'}  ·  Scale 1:${n}  ·  onsketch.io`, x0, y);
  const x1 = (sheet.pw - PRINT_MARGIN) * mm, xa = x1 - check * mm;
  ctx.beginPath();
  ctx.moveTo(xa, y - 1); ctx.lineTo(x1, y - 1);
  ctx.moveTo(xa, y - 5); ctx.lineTo(xa, y + 3); ctx.moveTo(x1, y - 5); ctx.lineTo(x1, y + 3);
  ctx.stroke();
  ctx.textAlign = 'right';
  ctx.fillText(`this line is ${check} mm on paper${n > 1 ? ` (${check * n} mm real)` : ''}`, xa - 8, y);
  ctx.restore();
  return {
    svg: ctx.toSVG({ size: { width: sheet.pw + 'mm', height: sheet.ph + 'mm' }, title: src.project.name || 'OnSketch' }),
    pw: sheet.pw, ph: sheet.ph, landscape: sheet.landscape, fits, scale: n,
  };
}

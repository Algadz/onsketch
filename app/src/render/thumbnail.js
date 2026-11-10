import { Arc, Circle, Line, Point } from '../core/entities.js';
import { Renderer } from './renderer.js';
import { View } from './view.js';
import { inkBounds } from '../core/strokes.js';

/* =============== PROJECT THUMBNAIL ==============================
   Draws the whole project (fills, shapes, ink) on an off-screen canvas,
   fitted, in the light theme, without grid, dimensions, relations,
   selection or hover (laid out at 320 × 200, drawn at 2×, so lines stay
   visible on a card), and returns it as a WebP blob (PNG where WebP
   encoding isn't supported). Used for the cards on My sketches.
   ============================================================ */
export const THUMB_W = 640, THUMB_H = 400;

/** Bounding box of everything drawn, in world units, or null. */
export function projectBounds(project) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const s of project.sketches) {
    if (!s.visible) continue;
    for (const e of s.entities) {
      if (project.layerOf(e)?.visible === false) continue;
      if (e instanceof Line) { acc(e.p1.x, e.p1.y); acc(e.p2.x, e.p2.y); }
      else if (e instanceof Circle || e instanceof Arc) { acc(e.center.x - e.r, e.center.y - e.r); acc(e.center.x + e.r, e.center.y + e.r); }
      else if (e instanceof Point) acc(e.x, e.y);
    }
    for (const st of s.strokes || []) {
      if (project.layer(st.layerId)?.visible === false) continue;
      const b = inkBounds(st);
      acc(b.minX, b.minY); acc(b.maxX, b.maxY);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** Renders `project` to a canvas. `fillDisplay` is the editor's
 *  layerId → { painted } map (App.fillDisplay()). */
export function renderThumbnail(project, fillDisplay = new Map(), { width = THUMB_W / 2, height = THUMB_H / 2, scale = 2 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const view = new View();
  view.cssW = width; view.cssH = height;
  const bounds = projectBounds(project);
  if (bounds) {
    const pad = Math.round(Math.min(width, height) * 0.1);
    if (bounds.maxX - bounds.minX < 1e-9 && bounds.maxY - bounds.minY < 1e-9) { view.panX = -bounds.minX * view.zoom; view.panY = bounds.minY * view.zoom; }
    else view.fitTo(bounds, pad);
  }
  const r = new Renderer(canvas, view);
  r.dpr = scale;
  r.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  // Hide editor-only state (hover, selection) while drawing.
  const flags = [];
  for (const s of project.sketches) for (const e of s.entities) for (const x of [e, ...e.children()]) {
    if (x.hover || x.selected) { flags.push([x, x.hover, x.selected]); x.hover = false; x.selected = false; }
  }
  for (const s of project.sketches) for (const st of s.strokes || []) {
    if (st.selected) { flags.push([st, false, true]); st.selected = false; }
  }
  try {
    r.drawGrid(false, project.background);            // clears, paints the canvas colour if any
    r.ctx.globalCompositeOperation = 'destination-over';
    r.ctx.fillStyle = '#ffffff';
    r.ctx.fillRect(0, 0, width, height);
    r.ctx.globalCompositeOperation = 'source-over';
    r.drawEntities(project, fillDisplay);
  } finally {
    for (const [x, h, s] of flags) { if (h) x.hover = h; x.selected = s; }
  }
  return canvas;
}

/** The thumbnail as an image blob (WebP, else PNG). */
export function thumbnailBlob(project, fillDisplay, opts) {
  const canvas = renderThumbnail(project, fillDisplay, opts);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b && b.type === 'image/webp') return resolve(b);
      canvas.toBlob((p) => p ? resolve(p) : reject(new Error('could not encode thumbnail')), 'image/png');
    }, 'image/webp', 0.85);
  });
}

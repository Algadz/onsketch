import { Arc, Bezier, Circle, Line } from '../core/entities.js';
import { findFaceAt } from '../core/regions.js';
import { imagePixelSize } from '../core/images.js';
import { exportSVG } from './export.js';

/* =============== A SKETCH AS SVG, WITHOUT THE EDITOR =============
   What export.js needs beyond the project, worked out here the way the
   editor does it, so a picture of a sketch made on the server (the MCP
   server's previews and export_sketch) looks like the editor's export:
     fills      each fill's area: the face of its layer's shapes around
                its seed point (app/fills.js)
     pictures   without a DOM there is no <img>: a stand-in with the
                picture's data URL and pixel size, which the SVG writer
                embeds as <image href="data:…">
   ============================================================ */

/** The renderer's fill display: layer id → { painted: fills with areas }. */
export function fillDisplayFor(project) {
  const out = new Map();
  const sketch = project.active();
  if (!sketch) return out;
  for (const f of sketch.fills || []) {
    const shapes = sketch.entities.filter(e => !e.construction && e.layerId === f.layerId
      && (e instanceof Line || e instanceof Arc || e instanceof Circle || e instanceof Bezier));
    const region = findFaceAt(shapes, f.seed);
    if (!region) continue;
    if (!out.has(f.layerId)) out.set(f.layerId, { painted: [] });
    out.get(f.layerId).painted.push({ ...f, region });
  }
  return out;
}

/** Lets core/images.js hand out pictures without a DOM. */
function ensureImageStandIn() {
  if (typeof globalThis.Image !== 'undefined') return;
  globalThis.Image = class {
    constructor() { this.complete = true; this.naturalWidth = 1; this.naturalHeight = 1; this._src = ''; }
    get src() { return this._src; }
    set src(v) {
      this._src = v;
      const px = imagePixelSize(v);
      if (px) { this.naturalWidth = px.w; this.naturalHeight = px.h; }
    }
  };
}

/** SVG text of the sketch (fitted, light theme), or null when empty.
 *  opts: { dimensions, construction, maxSide } */
export function sketchSVG(project, opts = {}) {
  ensureImageStandIn();
  return exportSVG({ project, fillDisplay: fillDisplayFor(project) }, { dimensions: !!opts.dimensions, construction: !!opts.construction });
}

import { newId } from '../core/entities.js';
import { findFaceAt, regionContains } from '../core/regions.js';

/* =============== FILL TOOL =====================================
   Click inside any closed region made by existing geometry, including
   regions bounded by several shapes that share or cross edges. The
   fill stores the entities around the region and a point inside it,
   so it follows the geometry when it moves. Boundaries come from every
   visible, non-construction line / arc / circle; the fill itself lives
   on the active layer.
   ============================================================ */
export class FillsMixin {
  _fillBoundaryEntities(sketch) {
    return sketch.entities.filter(e => !e.construction && this.isEntityVisible(e)
      && (e.constructor.kind === 'line' || e.constructor.kind === 'arc' || e.constructor.kind === 'circle'));
  }

  /** Current region of a stored fill, or null if it no longer closes. */
  _fillRegion(sketch, f) {
    const byId = new Map(sketch.entities.map(e => [e.id, e]));
    return findFaceAt(f.ids.map(id => byId.get(id)).filter(Boolean), f.seed);
  }

  /** Topmost fill on the active layer covering the point. */
  _fillAt(sketch, world) {
    for (let i = sketch.fills.length - 1; i >= 0; i--) {
      const f = sketch.fills[i];
      if (f.layerId !== this.project.activeLayerId) continue;
      const r = this._fillRegion(sketch, f);
      if (r && regionContains(r, world)) return f;
    }
    return null;
  }

  bucketFillAt(world) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const pen = this.pen;
    const region = findFaceAt(this._fillBoundaryEntities(sketch), world);
    if (!region) {
      this.project.background = pen.fillColor;
    } else {
      // Refilling a region already filled on this layer recolours it.
      const existing = this._fillAt(sketch, world);
      if (existing) {
        existing.color = pen.fillColor;
        existing.opacity = pen.fillOpacity;
      } else {
        sketch.fills.push({ id: newId('f'), layerId: this.project.activeLayerId,
          color: pen.fillColor, opacity: pen.fillOpacity, ids: region.ids, seed: { x: world.x, y: world.y } });
      }
    }
    this.commit();
    this.refreshUI();
  }

  eraseFillAt(world) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const f = this._fillAt(sketch, world);
    if (f) sketch.fills = sketch.fills.filter(x => x !== f);
    else if (!findFaceAt(this._fillBoundaryEntities(sketch), world)) this.project.background = null;
    else return;
    this.commit();
    this.refreshUI();
  }
}

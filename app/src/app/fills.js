import { newId } from '../core/entities.js';
import { findFaceAt, fillOutline, pointInPolygon } from '../render/regions.js';

/* =============== PAINT-BUCKET FILLS ============================
   Fills reference their boundary entities by id, so they follow the
   geometry when it is dragged or re-dimensioned. Boundaries come from
   every visible, non-construction line / arc / circle; the fill itself
   lives on the active layer.
   ============================================================ */
export class FillsMixin {
  _fillBoundaryEntities(sketch) {
    return sketch.entities.filter(e => !e.construction && this.isEntityVisible(e)
      && (e.constructor.kind === 'line' || e.constructor.kind === 'arc' || e.constructor.kind === 'circle'));
  }

  bucketFillAt(world) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const pen = this.pen;
    const region = findFaceAt(this._fillBoundaryEntities(sketch), world);
    if (!region) {
      this.project.background = pen.fillColor;
    } else {
      const layerId = this.project.activeLayerId;
      const same = (a, b) => a.length === b.length && a.every(id => b.includes(id));
      // Refilling the same region on this layer recolours it.
      const existing = sketch.fills.find(f => f.layerId === layerId && same(f.outer, region.outer));
      if (existing) {
        existing.color = pen.fillColor; existing.opacity = pen.fillOpacity; existing.holes = region.holes;
      } else {
        sketch.fills.push({ id: newId('f'), layerId, color: pen.fillColor, opacity: pen.fillOpacity,
          outer: region.outer, holes: region.holes });
      }
    }
    this.commit();
    this.refreshUI();
  }

  /** Topmost fill on the active layer whose region contains the point. */
  _fillAt(sketch, world) {
    const byId = new Map(sketch.entities.map(e => [e.id, e]));
    const pick = (ids) => ids.map(id => byId.get(id)).filter(Boolean);
    for (let i = sketch.fills.length - 1; i >= 0; i--) {
      const f = sketch.fills[i];
      if (f.layerId !== this.project.activeLayerId) continue;
      const inOuter = fillOutline(pick(f.outer)).some(l => pointInPolygon(world, l));
      const inHole = f.holes.some(h => fillOutline(pick(h)).some(l => pointInPolygon(world, l)));
      if (inOuter && !inHole) return f;
    }
    return null;
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

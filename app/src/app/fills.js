import { newId } from '../core/entities.js';
import { findFaceAt, geometryKey, reconcileFills, regionContains } from '../core/regions.js';

/* =============== FILL TOOL =====================================
   Fills are paint on areas, like Live Paint. A fill is a colour and a
   point inside its area; the area is the closed region that its layer's
   shapes (that layer only) form around that point.

   When shapes change, colours are carried over by overlap
   (reconcileFills): a split keeps the colour on both pieces, a merge
   takes the majority colour, an area re-cut differently takes the colour
   that covered most of each new piece, and paint whose area opened up
   becomes dormant (hidden, ghosted while dragging, restored if an area
   closes there again).

   While a drag is in progress the stored fills are not touched: the
   display is recomputed against them every frame, so dragging back
   restores exactly what was there. The new colouring is stored on
   commit (release), before the undo snapshot.
   ============================================================ */
export class FillsMixin {
  /** Shapes of one layer that can bound a fill. */
  _layerShapes(sketch, layerId) {
    return sketch.entities.filter(e => !e.construction && e.layerId === layerId
      && (e.constructor.kind === 'line' || e.constructor.kind === 'arc' || e.constructor.kind === 'circle'));
  }

  /** Attach each stored fill's current region (after load / undo). */
  _primeFillRegions() {
    const sketch = this.activeSketch(); if (!sketch) return;
    for (const f of sketch.fills) {
      if (f.dormant) { f.region = null; continue; }
      f.region = findFaceAt(this._layerShapes(sketch, f.layerId), f.seed);
      if (!f.region) { f.dormant = true; f.outline = f.outline || null; }
    }
    this._fillDisplayCache = null;
  }

  /** Colouring of every layer for the current geometry, against the
   *  stored fills. Cached on geometry + fills. */
  _fillAssignment() {
    const sketch = this.activeSketch(); if (!sketch || !sketch.fills.length) return new Map();
    // Fills that arrived without a region (import, new file) get one now.
    if (sketch.fills.some(f => !f.dormant && !f.region)) {
      for (const f of sketch.fills) {
        if (f.dormant || f.region) continue;
        f.region = findFaceAt(this._layerShapes(sketch, f.layerId), f.seed);
        if (!f.region) f.dormant = true;
      }
    }
    const byLayer = new Map();
    for (const f of sketch.fills) {
      if (!byLayer.has(f.layerId)) byLayer.set(f.layerId, []);
      byLayer.get(f.layerId).push(f);
    }
    const keyParts = [];
    for (const [layerId, fills] of byLayer) {
      keyParts.push(layerId, geometryKey(this._layerShapes(sketch, layerId)),
        fills.map(f => [f.id, f.color, f.opacity, f.seed.x, f.seed.y, f.dormant ? 1 : 0, f.region ? 1 : 0].join(':')).join(';'));
    }
    const key = keyParts.join('|');
    if (this._fillDisplayCache && this._fillDisplayCache.key === key) return this._fillDisplayCache.map;
    const map = new Map();
    for (const [layerId, fills] of byLayer) {
      map.set(layerId, reconcileFills(fills, this._layerShapes(sketch, layerId), () => newId('f')));
    }
    this._fillDisplayCache = { key, map };
    return map;
  }

  /** What the renderer draws per layer: painted areas, and while dragging
   *  the ghost outlines of paint whose area has opened up. */
  fillDisplay() {
    const out = new Map();
    const dragging = !!this.tool?.dragging;
    for (const [layerId, res] of this._fillAssignment()) {
      out.set(layerId, {
        painted: res.fills.filter(f => !f.dormant && f.region),
        ghosts: dragging ? res.fills.filter(f => f.dormant && f.outline) : [],
      });
    }
    return out;
  }

  /** Store the colouring for the current geometry (called by commit). */
  _reconcileStoredFills() {
    const sketch = this.activeSketch(); if (!sketch || !sketch.fills.length) return;
    const before = sketch.fills.filter(f => f.dormant).length;
    const assignment = this._fillAssignment();
    const order = [...new Set(sketch.fills.map(f => f.layerId))];
    sketch.fills = order.flatMap(id => assignment.get(id)?.fills || []);
    this._fillDisplayCache = null;
    const dormant = sketch.fills.filter(f => f.dormant).length;
    if (dormant > before) {
      document.getElementById('status-hint').textContent =
        `${dormant} fill${dormant > 1 ? 's' : ''} hidden: ${dormant > 1 ? 'their areas are' : 'its area is'} no longer closed. ` +
        `${dormant > 1 ? 'They come' : 'It comes'} back if the area closes again (Fill tool options: delete hidden fills).`;
    }
  }

  dormantFillCount() {
    const sketch = this.activeSketch();
    return sketch ? sketch.fills.filter(f => f.dormant).length : 0;
  }

  deleteDormantFills() {
    const sketch = this.activeSketch(); if (!sketch) return;
    sketch.fills = sketch.fills.filter(f => !f.dormant);
    this.commit();
    this.refreshUI();
  }

  /** Stored painted fill on the active layer covering the point. */
  _fillAt(sketch, world) {
    for (let i = sketch.fills.length - 1; i >= 0; i--) {
      const f = sketch.fills[i];
      if (f.dormant || f.layerId !== this.project.activeLayerId || !f.region) continue;
      if (regionContains(f.region, world)) return f;
    }
    return null;
  }

  /** Click inside a closed area of the active layer's shapes to fill it;
   *  anywhere else fills the background. Other layers are ignored. */
  bucketFillAt(world) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const pen = this.pen;
    const region = findFaceAt(this._layerShapes(sketch, this.project.activeLayerId), world);
    if (!region) {
      this.project.background = pen.fillColor;
    } else {
      const existing = this._fillAt(sketch, world);
      if (existing) {
        existing.color = pen.fillColor;
        existing.opacity = pen.fillOpacity;
      } else {
        sketch.fills.push({ id: newId('f'), layerId: this.project.activeLayerId,
          color: pen.fillColor, opacity: pen.fillOpacity, seed: { x: world.x, y: world.y }, region });
      }
    }
    this._fillDisplayCache = null;
    this.commit();
    this.refreshUI();
  }

  eraseFillAt(world) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const f = this._fillAt(sketch, world);
    if (f) sketch.fills = sketch.fills.filter(x => x !== f);
    else if (!findFaceAt(this._layerShapes(sketch, this.project.activeLayerId), world)) this.project.background = null;
    else return;
    this._fillDisplayCache = null;
    this.commit();
    this.refreshUI();
  }
}

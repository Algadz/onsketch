import { newId } from '../core/entities.js';
import { findFaceAt, geometryKey, reconcileRegions, referenceRegions, regionContains } from '../core/regions.js';

/* =============== FILL TOOL =====================================
   Fills are paint on areas, like Live Paint. A fill is a colour and a
   point inside its area; the area is the closed region that its layer's
   shapes (that layer only) form around that point.

   When shapes change, colours are carried over to the areas
   (reconcileRegions): moved / resized shapes keep their colour, a split
   keeps it on both pieces, a merge takes the majority colour, a re-cut
   area takes the colour that covered most of each new piece. Paint whose
   area no longer exists is removed; Undo brings it back.

   While a drag is in progress the stored fills are not touched: the
   display is recomputed against them every frame, so dragging back
   restores exactly what was there. The new colouring is stored on
   commit (release), after the final solve and before the undo snapshot.
   ============================================================ */
export class FillsMixin {
  /** Shapes of one layer that can bound a fill. */
  _layerShapes(sketch, layerId) {
    return sketch.entities.filter(e => !e.construction && e.layerId === layerId
      && (e.constructor.kind === 'line' || e.constructor.kind === 'arc' || e.constructor.kind === 'circle'));
  }

  /** Attach each stored fill's current area (after load / undo); paint
   *  whose area isn't closed is dropped. */
  _primeFillRegions() {
    const sketch = this.activeSketch(); if (!sketch) return;
    this._attachFillRegions(sketch);
    this._fillDisplayCache = null;
    this._rebuildFillRefs();
  }
  _attachFillRegions(sketch) {
    for (const f of sketch.fills) if (!f.region) f.region = findFaceAt(this._layerShapes(sketch, f.layerId), f.seed);
    sketch.fills = sketch.fills.filter(f => f.region);
  }

  /** Reference for recolouring: every area of each painted layer as it is
   *  now (painted or not). Rebuilt on commit / load / undo / paint, never
   *  during a drag, so a drag always compares against its start. */
  _rebuildFillRefs() {
    const sketch = this.activeSketch(); if (!sketch) { this._fillRefs = null; return; }
    const layers = new Map();
    for (const f of sketch.fills) {
      if (!layers.has(f.layerId)) layers.set(f.layerId, []);
      layers.get(f.layerId).push(f);
    }
    const map = new Map();
    for (const [layerId, fills] of layers) map.set(layerId, referenceRegions(fills, this._layerShapes(sketch, layerId)));
    this._fillRefs = { map, sig: this._fillsSignature(sketch) };
  }
  _fillsSignature(sketch) {
    return sketch.fills.map(f => [f.id, f.color, f.opacity, f.seed.x, f.seed.y].join(':')).join(';');
  }

  /** Colouring of every layer for the current geometry, against the
   *  reference. Cached on geometry + fills. */
  _fillAssignment() {
    const sketch = this.activeSketch(); if (!sketch || !sketch.fills.length) return new Map();
    // Fills that arrived without an area (import, new file) get one now.
    if (sketch.fills.some(f => !f.region)) this._attachFillRegions(sketch);
    const byLayer = new Map();
    for (const f of sketch.fills) {
      if (!byLayer.has(f.layerId)) byLayer.set(f.layerId, []);
      byLayer.get(f.layerId).push(f);
    }
    // Stored fills changed outside a drag (paint, erase, load): new reference.
    const sig = this._fillsSignature(sketch);
    if (!this._fillRefs || this._fillRefs.sig !== sig) this._rebuildFillRefs();
    const keyParts = [sig];
    for (const [layerId] of byLayer) keyParts.push(layerId, geometryKey(this._layerShapes(sketch, layerId)));
    const key = keyParts.join('|');
    if (this._fillDisplayCache && this._fillDisplayCache.key === key) return this._fillDisplayCache.map;
    const map = new Map();
    for (const [layerId] of byLayer) {
      map.set(layerId, reconcileRegions(this._fillRefs.map.get(layerId) || [], this._layerShapes(sketch, layerId), () => newId('f')));
    }
    this._fillDisplayCache = { key, map };
    return map;
  }

  /** What the renderer draws per layer: the painted areas. */
  fillDisplay() {
    const out = new Map();
    for (const [layerId, res] of this._fillAssignment()) out.set(layerId, { painted: res.fills });
    return out;
  }

  /** Store the colouring for the current geometry (called by commit). */
  _reconcileStoredFills() {
    const sketch = this.activeSketch(); if (!sketch || !sketch.fills.length) return;
    const assignment = this._fillAssignment();
    const order = [...new Set(sketch.fills.map(f => f.layerId))];
    sketch.fills = order.flatMap(id => assignment.get(id)?.fills || []);
    this._fillDisplayCache = null;
    this._rebuildFillRefs();                // the new state is the next reference
  }

  /** Stored painted fill on the active layer covering the point. */
  _fillAt(sketch, world) {
    for (let i = sketch.fills.length - 1; i >= 0; i--) {
      const f = sketch.fills[i];
      if (f.layerId !== this.project.activeLayerId || !f.region) continue;
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

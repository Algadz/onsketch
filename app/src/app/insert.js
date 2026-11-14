import { insertProject } from '../core/insert.js';
import { notice } from '../ui/dialogs.js';
import { track } from '../ui/analytics.js';

/* =============== INSERT A SKETCH AS A PART =====================
   A saved sketch placed inside the open drawing at real size, so parts
   drawn once (a connector, a standard component, a desk) are reused
   instead of redrawn (core/insert.js does the work):

   - Open ▸ Insert, next to each of your sketches;
   - the library: "Insert into my sketch" (/app/?insert=<id>).

   The part lands in the middle of the view, selected, on its own layer,
   free to drag or to dimension against the drawing. One undo step.
   ============================================================ */
export class InsertMixin {
  /** @returns {boolean} whether anything was inserted */
  insertSketchData(data, name, from = 'account') {
    const sketch = this.activeSketch(); if (!sketch) return false;
    this.finishTextEdit?.();
    const at = this.view.screenToWorld({ x: this.view.cssW / 2, y: this.view.cssH / 2 });
    let res = null;
    try { res = insertProject(this.project, data, { at, name }); }
    catch (e) { console.warn('insert failed', e); notice("Couldn't insert this sketch.", { kind: 'error' }); return false; }
    if (!res) { notice('That sketch is empty: there is nothing to insert.'); return false; }
    this.setTool('select');
    this.clearSelection();
    const ids = new Set(res.entityIds), ink = new Set(res.strokeIds);
    for (const e of sketch.entities) if (ids.has(e.id)) this.setSelected(e, true);
    for (const s of sketch.strokes) if (ink.has(s.id)) s.selected = true;
    this.commit({ diagnostics: 'sync' });
    this._primeFillRegions();
    this._refreshLayerPanel?.();
    this.refreshUI();
    // Bring it into view when it is larger than what is shown.
    const a = this.view.worldToScreen({ x: res.bounds.minX, y: res.bounds.maxY }), b = this.view.worldToScreen({ x: res.bounds.maxX, y: res.bounds.minY });
    if (a.x < 0 || a.y < 0 || b.x > this.view.cssW || b.y > this.view.cssH) this.zoomFit();
    this.requestRender();
    notice(`"${res.name}" inserted at real size, on its own layer. Drag it into place, or dimension it against your drawing.`, { ms: 6000 });
    track('sketch-insert', { from });
    return true;
  }

  /** /app/?insert=<id> from the library: a public sketch as a part. */
  async insertPublicSketch(id) {
    let row;
    try { row = await this.cloud.load(id); }
    catch { this._hint("This sketch isn't public any more, or the link is wrong."); return; }
    this.insertSketchData(row.data, row.name, 'library');
  }
}

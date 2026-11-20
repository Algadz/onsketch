import { newId } from '../core/entities.js';
import { isShape, shapeFrame, shapeLabel } from '../core/shapes.js';
import { Tool } from './tool.js';

/* =============== SHAPES TOOL (U) ===============================
   Pick a shape in the Sketch window (rectangle, ellipse, star…), then
   drag a box on the canvas: the shape fills it.
   - Shift: equal sides (a square, a circle, a regular star);
   - Ctrl / ⌘: from the middle (the press is the centre);
   - corners snap like line ends with Snap on (Alt: no snap);
   - a click without a drag on a shape selects it to restyle it;
   - Esc cancels the drag, then deselects, then goes back to Select.
   The shape just drawn is selected, so its colour, outline, fill and
   line can be changed right away (that also sets the next one's style).
   Shapes are ink: on the active layer, never solved, one undo step each;
   with the Select tool their box handles resize, stretch and turn them.
   ============================================================ */
export class ShapeTool extends Tool {
  constructor(app) { super(app); this.start = null; this.end = null; this.mods = {}; }
  hint() { return `Drag a box to draw a ${shapeLabel(this.app.inkSettings('shape').shape).toLowerCase()}. Shift: equal sides, Ctrl: from the middle. Pick another shape in the Sketch window.`; }
  activate() { this.start = null; }
  deactivate() { this.start = null; }

  _at(world, snap) { const p = snap && !snap.rejected ? snap : world; return { x: p.x, y: p.y }; }
  _mods(ev) { return { square: !!ev?.shiftKey, center: !!(ev?.ctrlKey || ev?.metaKey) }; }

  onPointerDown(world, snap, ev) {
    if (ev && ev.button !== 0) return;
    this.start = this._at(world, snap);
    this.raw = { x: world.x, y: world.y };
    this.end = { ...this.start };
    this.mods = this._mods(ev);
  }
  onPointerMove(world, snap, ev) {
    if (!this.start) return;
    if (ev && ev.pointerType === 'mouse' && !(ev.buttons & 1)) { this.onPointerUp(world, snap, ev); return; }
    this.end = this._at(world, snap);
    this.mods = this._mods(ev);
  }
  onPointerUp(world, snap, ev) {
    if (!this.start) return;
    const start = this.start, end = world ? this._at(world, snap) : this.end;
    const mods = ev ? this._mods(ev) : this.mods;
    this.start = this.end = null;
    const min = 4 / this.app.view.zoom;
    if (Math.abs(end.x - start.x) < min && Math.abs(end.y - start.y) < min) {
      const hit = this.app.hitStrokeAt(this.raw || start);
      if (isShape(hit)) {
        this.app.setInkCurrent(hit);
        this._say('Shape selected: change its colour, outline, fill or line to restyle it. Delete removes it, Esc deselects.');
      } else {
        this.app.releaseInkCurrent();
        this._say(this.hint());
      }
      this.app.requestRender();
      return;
    }
    this.app.releaseInkCurrent();
    const item = this._make(start, end, mods);
    this.app.addStroke(item);
    this.app.setInkCurrent(item);
    this._say(`${shapeLabel(item.shape)} added. Change its colour, outline, fill or line now to restyle it, or drag the next one. Delete removes it, Esc deselects.`);
  }
  onKey(ev) {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !this.start && this.app.deleteInkCurrent()) {
      ev.preventDefault();
      this._say(this.hint());
      return;
    }
    if (ev.key === 'Escape') {
      if (this.start) { this.start = this.end = null; this.app.requestRender(); }
      else if (this.app.releaseInkCurrent()) this._say(this.hint());
      else this.app.setTool('select');
    }
  }
  _say(t) { const el = document.getElementById('status-hint'); if (el) el.textContent = t; }

  _make(start, end, mods) {
    const s = this.app.inkSettings('shape');
    const item = {
      id: newId('k'), layerId: this.app.project.activeLayerId, kind: 'shape', shape: s.shape,
      color: this.app.pen.fillColor, opacity: 1, width: s.size,
      points: shapeFrame(start, end, mods),
    };
    if (s.fill !== 'none') item.fill = s.fill;
    if (s.dash) item.dash = true;
    return item;
  }
  getPreview() {
    if (!this.start || !this.end) return null;
    return { strokes: [this._make(this.start, this.end, this.mods)] };
  }
}

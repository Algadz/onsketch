import { newId } from '../core/entities.js';
import { attachFromSnap, constrainAngle } from '../core/arrows.js';
import { Tool } from './tool.js';

/* =============== ARROW TOOL (W) ================================
   Press where the arrow starts, drag to what it points at, release:
   the head is where you release (Ends: tip / both / none; Head: filled,
   open, dot; Line: solid, dashed; width in screen px stored in world
   units, like the pen).
   - With Snap on, each end snaps like a line end (endpoint, midpoint,
     centre, on a line or a circle) and, when it lands on a shape, stays
     attached to it: the end follows that shape when the design changes.
     The snap marker and its label show while dragging.
   - Shift keeps the arrow at 15° steps (from the tail).
   - A press-and-release without a drag draws nothing; Esc cancels.
   Arrows are ink: on the active layer, never solved, one undo step each.
   ============================================================ */
export class ArrowTool extends Tool {
  constructor(app) { super(app); this.start = null; this.end = null; this.cursor = null; }
  hint() { return 'Drag from where the arrow starts to what it points at. Ends dropped on shapes stay attached (Snap). Shift: 15° steps.'; }
  activate() { this.start = null; }
  deactivate() { this.start = null; }

  onPointerDown(world, snap, ev) {
    if (ev && ev.button !== 0) return;
    const p = snap && !snap.rejected ? snap : world;
    this.start = { x: p.x, y: p.y, at: attachFromSnap(snap) };
    this.end = { x: p.x, y: p.y, at: null };
  }
  onPointerMove(world, snap, ev) {
    this.cursor = world;
    if (!this.start) return;
    if (ev && ev.pointerType === 'mouse' && !(ev.buttons & 1)) { this.onPointerUp(world, snap, ev); return; }
    this.end = this._endAt(world, snap, ev);
  }
  _endAt(world, snap, ev) {
    if (ev && ev.shiftKey) {
      const p = constrainAngle(this.start, world);
      this.app.lastSnap = null;
      return { x: p.x, y: p.y, at: null };
    }
    const p = snap && !snap.rejected ? snap : world;
    return { x: p.x, y: p.y, at: attachFromSnap(snap) };
  }
  onPointerUp(world, snap, ev) {
    if (!this.start) return;
    const end = world ? this._endAt(world, snap, ev) : this.end;
    const start = this.start;
    this.start = this.end = null;
    const minLen = 4 / this.app.view.zoom;
    if (Math.hypot(end.x - start.x, end.y - start.y) < minLen) {
      document.getElementById('status-hint').textContent = 'Drag to draw an arrow: the head goes where you release.';
      this.app.requestRender();
      return;
    }
    const a = this._make(start, end);
    if (start.at || end.at) a.at = [start.at, end.at];
    this.app.addStroke(a);
  }
  onKey(ev) {
    if (ev.key === 'Escape') {
      if (this.start) { this.start = this.end = null; this.app.requestRender(); }
      else this.app.setTool('select');
    }
  }
  _make(start, end) {
    const s = this.app.inkSettings('arrow');
    const a = {
      id: newId('k'), layerId: this.app.project.activeLayerId, kind: 'arrow',
      color: this.app.pen.fillColor, opacity: 1,
      width: s.size / this.app.view.zoom,
      points: [{ x: start.x, y: start.y }, { x: end.x, y: end.y }],
    };
    if (s.tips !== 'end') a.tips = s.tips;
    if (s.head !== 'filled') a.head = s.head;
    if (s.dash) a.dash = true;
    return a;
  }
  getPreview() {
    if (!this.start || !this.end) return null;
    return { strokes: [this._make(this.start, this.end)] };
  }
}

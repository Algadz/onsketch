import { newId } from '../core/entities.js';
import { inkHit, simplifyPoints } from '../core/strokes.js';
import { Tool } from './tool.js';

/* =============== SKETCH TOOLS (freehand) =======================
   Pen and Marker draw strokes; Eraser removes whole strokes. They work
   on the active layer only, never snap, and never touch the solver.
   Sizes are chosen in screen pixels and stored in world units, so what
   you see while drawing is what you get, and the ink then scales with
   zoom like ink on paper. One stroke or one eraser drag = one undo step.
   ============================================================ */

/** World points under every pointer sample of this event (coalesced
 *  samples give smooth curves on fast strokes). */
function samples(app, ev, fallback) {
  const list = ev && typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
  if (!list.length) return [fallback];
  const r = app.canvas.getBoundingClientRect();
  return list.map(e => app.view.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top }));
}

/** Pen ('pen') or Marker ('marker'): press, drag, release. */
export class InkTool extends Tool {
  constructor(app, kind) { super(app); this.kind = kind; this.points = null; this.cursor = null; }
  hint() {
    return this.kind === 'marker'
      ? 'Drag to highlight. Marker ink is see-through and sits on top of the active layer.'
      : 'Drag to draw freehand ink on the active layer. Strokes are not solved or dimensioned.';
  }
  activate() { this.points = null; }
  deactivate() { this.points = null; }
  _settings() { return this.app.inkSettings(this.kind); }

  onPointerDown(world, _snap, ev) {
    if (ev && ev.button !== 0) return;
    this.points = [{ x: world.x, y: world.y }];
  }
  onPointerMove(world, _snap, ev) {
    this.cursor = world;
    if (!this.points) return;
    if (ev && !(ev.buttons & 1)) { this.onPointerUp(world); return; }
    const minStep = 0.75 / this.app.view.zoom;           // ~1 screen px
    for (const p of samples(this.app, ev, world)) {
      const last = this.points[this.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= minStep) this.points.push({ x: p.x, y: p.y });
    }
  }
  onPointerUp(world) {
    if (!this.points) return;
    const pts = this.points;
    this.points = null;
    const last = pts[pts.length - 1];
    if (world && Math.hypot(world.x - last.x, world.y - last.y) > 1e-9) pts.push({ x: world.x, y: world.y });
    this.app.addStroke(this._make(simplifyPoints(pts, 0.35 / this.app.view.zoom)));
  }
  onKey(ev) {
    if (ev.key === 'Escape') {
      if (this.points) { this.points = null; this.app.requestRender(); }
      else this.app.setTool('select');
    }
  }
  _make(points) {
    const s = this._settings();
    return {
      id: newId('k'), layerId: this.app.project.activeLayerId, kind: this.kind,
      color: this.app.pen.fillColor, opacity: s.opacity,
      width: s.size / this.app.view.zoom, points,
    };
  }
  getPreview() {
    const out = {};
    if (this.points) out.strokes = [this._make(this.points)];
    else if (this.cursor) out.brush = { center: this.cursor, r: this._settings().size / 2 / this.app.view.zoom };
    return out;
  }
}

/** Removes every stroke of the active layer the eraser passes over. */
export class EraserTool extends Tool {
  constructor(app) { super(app); this.erasing = false; this.removed = 0; this.cursor = null; }
  hint() { return 'Drag over strokes on the active layer to erase them. Shapes and fills are not affected.'; }
  activate() { this.erasing = false; }
  _radius() { return this.app.inkSettings('eraser').size / 2 / this.app.view.zoom; }
  _eraseAt(points) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const layerId = this.app.project.activeLayerId;
    const r = this._radius();
    const before = sketch.strokes.length;
    sketch.strokes = sketch.strokes.filter(s => s.layerId !== layerId || !points.some(p => inkHit(s, p, r)));
    this.removed += before - sketch.strokes.length;
  }
  onPointerDown(world, _snap, ev) {
    if (ev && ev.button !== 0) return;
    this.erasing = true; this.removed = 0; this.last = world;
    this._eraseAt([world]);
  }
  onPointerMove(world, _snap, ev) {
    this.cursor = world;
    if (!this.erasing) return;
    if (ev && !(ev.buttons & 1)) { this.onPointerUp(); return; }
    // Sample the path since the last event so fast drags don't skip ink.
    const pts = [];
    for (const p of samples(this.app, ev, world)) {
      const d = Math.hypot(p.x - this.last.x, p.y - this.last.y);
      const n = Math.max(1, Math.ceil(d / Math.max(this._radius(), 1e-9)));
      for (let i = 1; i <= n; i++) pts.push({ x: this.last.x + (p.x - this.last.x) * i / n, y: this.last.y + (p.y - this.last.y) * i / n });
      this.last = p;
    }
    this._eraseAt(pts);
  }
  onPointerUp() {
    if (!this.erasing) return;
    this.erasing = false;
    if (this.removed) { this.app.commit(); this.app.refreshUI(); }
  }
  onKey(ev) { if (ev.key === 'Escape') this.app.setTool('select'); }
  getPreview() { return this.cursor ? { brush: { center: this.cursor, r: this._radius(), erase: true } } : null; }
}

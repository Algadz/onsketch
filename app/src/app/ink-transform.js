import { attachFromSnap, constrainAngle, isArrow, setArrowEnd } from '../core/arrows.js';
import { applyTransform, restore, rotateAbout, scaleAbout, snapAngle, snapshot } from '../core/ink-transform.js';
import { unionBounds } from '../core/strokes.js';

/* =============== RESIZE AND TURN SELECTED INK ==================
   With the Select tool, selected ink (strokes, arrows, texts, a group or
   any mix, no shapes) gets a transform box, as in drawing apps:

     corner handles   resize, keeping proportions (Shift: free)
     edge handles     stretch one way (Shift: keep proportions)
     round handle     above the box: turn about the middle (Shift: 15°)
     Alt              resize about the middle instead of the far side
     Esc              cancels while dragging
   A label above the box shows the scale or the angle while dragging.
   Right-click also offers Rotate 90°, Flip horizontal, Flip vertical.

   A single selected arrow shows its two end handles instead: drag an end
   to re-aim it; with Snap on it snaps and attaches like when drawing.

   Linked ink keeps its link (re-placed from where it lands); attached
   arrow ends that leave their shape detach. One gesture = one undo step.
   ============================================================ */
const PAD = 7;          // screen px between the ink and the box
const STEM = 24;        // screen px from the top edge to the turn handle

export class InkTransformMixin {
  _handleScale() { return this.touchUI ? 1.6 : 1; }

  /** What the transform handles act on now, or null. */
  _inkTransformTarget() {
    if (this.toolName !== 'select' || this.linkPick || this._textEdit) return null;
    const sketch = this.activeSketch(); if (!sketch) return null;
    // shapes or dimensions selected too: they move with the solver, no box
    if (sketch.constraints.some(c => c.selected)
      || sketch.entities.some(e => e.selected || e.children().some(c => c.selected))) return null;
    const items = this.selectedStrokes();
    if (!items.length) return null;
    if (items.length === 1 && isArrow(items[0])) return { kind: 'arrow', item: items[0] };
    return { kind: 'box', items };
  }

  /** Screen corners (TL, TR, BR, BL) and turn handle of the box. */
  _inkBoxScreen(items) {
    const b = unionBounds(items);
    if (!b) return null;
    const v = this.view, k = this._handleScale();
    const tl = v.worldToScreen({ x: b.minX, y: b.maxY }), br = v.worldToScreen({ x: b.maxX, y: b.minY });
    const x0 = tl.x - PAD, y0 = tl.y - PAD, x1 = br.x + PAD, y1 = br.y + PAD;
    return {
      bounds: b,
      corners: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
      turn: { x: (x0 + x1) / 2, y: y0 - STEM * k },
    };
  }

  /** Handle under a screen point: { type: 'corner' | 'edge', i },
   *  { type: 'turn' } or { type: 'end', i } (arrow), or null. */
  hitInkHandle(sx, sy) {
    const target = this._inkTransformTarget();
    if (!target) return null;
    const tol = 8 * this._handleScale();
    const near = (p) => Math.hypot(p.x - sx, p.y - sy) <= tol;
    if (target.kind === 'arrow') {
      for (let i = 1; i >= 0; i--) if (near(this.view.worldToScreen(target.item.points[i]))) return { type: 'end', i, item: target.item };
      return null;
    }
    const box = this._inkBoxScreen(target.items);
    if (!box) return null;
    if (near(box.turn)) return { type: 'turn', items: target.items, box };
    for (let i = 0; i < 4; i++) if (near(box.corners[i])) return { type: 'corner', i, items: target.items, box };
    for (let i = 0; i < 4; i++) {
      const a = box.corners[i], b = box.corners[(i + 1) % 4];
      if (near({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) return { type: 'edge', i, items: target.items, box };
    }
    return null;
  }

  /** CSS cursor for a handle. */
  inkHandleCursor(h) {
    if (!h) return null;
    if (h.type === 'end') return 'move';
    if (h.type === 'turn') return ROTATE_CURSOR;
    if (h.type === 'corner') return h.i % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
    return h.i % 2 === 0 ? 'ns-resize' : 'ew-resize';
  }

  beginInkTransform(h, world) {
    if (h.type === 'end') {
      const item = h.item;
      const orig = { points: item.points.map(p => ({ ...p })), at: item.at ? item.at.slice() : null };
      setArrowEnd(item, h.i, null);                 // the dragged end leaves its shape
      this._inkDragItems = new Set([item]);
      return { h, item, orig, moved: false, start: world };
    }
    const b = h.box.bounds;
    const corners = [{ x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY }, { x: b.maxX, y: b.minY }, { x: b.minX, y: b.minY }];
    const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    this._inkDragItems = new Set(h.items);
    return { h, items: h.items, snap: snapshot(h.items), corners, center, start: world, moved: false, label: null };
  }

  updateInkTransform(t, world, snap, ev) {
    if (!t.moved && Math.hypot(world.x - t.start.x, world.y - t.start.y) * this.view.zoom < 2) return;
    t.moved = true;
    const shift = !!ev?.shiftKey, alt = !!ev?.altKey;
    if (t.h.type === 'end') {
      const other = t.item.points[1 - t.h.i];
      const p = shift ? constrainAngle(other, world) : (snap && !snap.rejected ? snap : world);
      t.item.points = t.item.points.map((q, k) => (k === t.h.i ? { x: p.x, y: p.y } : q));
      t.attach = shift ? null : attachFromSnap(snap);
      if (shift) this.lastSnap = null;
      this.requestRender();
      return;
    }
    let M;
    if (t.h.type === 'turn') {
      const a0 = Math.atan2(t.start.y - t.center.y, t.start.x - t.center.x);
      let a = Math.atan2(world.y - t.center.y, world.x - t.center.x) - a0;
      if (shift) a = snapAngle(a);
      M = rotateAbout(t.center, a);
      let deg = Math.round(a * 180 / Math.PI) % 360;
      if (deg > 180) deg -= 360; if (deg <= -180) deg += 360;
      t.label = `${deg}°`;                          // counter-clockwise positive, as in CAD
    } else {
      const MIN = 0.02;
      if (t.h.type === 'corner') {
        // measured from where the handle was grabbed (it sits a few px
        // outside the ink), so the first move never jumps
        const o = alt ? t.center : t.corners[(t.h.i + 2) % 4];
        const ex = t.start.x - o.x, ey = t.start.y - o.y;
        let sx = Math.abs(ex) > 1e-12 ? (world.x - o.x) / ex : 1;
        let sy = Math.abs(ey) > 1e-12 ? (world.y - o.y) / ey : 1;
        if (!shift) {                                   // proportional: project on the diagonal
          const s = ((world.x - o.x) * ex + (world.y - o.y) * ey) / (ex * ex + ey * ey || 1);
          sx = sy = s;
        }
        sx = Math.max(MIN, sx); sy = Math.max(MIN, sy);
        M = scaleAbout(o, sx, sy);
        t.label = sx === sy ? `${Math.round(sx * 100)} %` : `${Math.round(sx * 100)} × ${Math.round(sy * 100)} %`;
      } else {
        const vertical = t.h.i % 2 === 0;               // top / bottom edge
        const a = t.corners[t.h.i], b = t.corners[(t.h.i + 1) % 4];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const o = alt ? t.center : { x: t.center.x * 2 - mid.x, y: t.center.y * 2 - mid.y };
        const e = vertical ? t.start.y - o.y : t.start.x - o.x;
        let s = Math.abs(e) > 1e-12 ? ((vertical ? world.y - o.y : world.x - o.x) / e) : 1;
        s = Math.max(MIN, s);
        M = shift ? scaleAbout(o, s, s) : (vertical ? scaleAbout(o, 1, s) : scaleAbout(o, s, 1));
        t.label = `${Math.round(s * 100)} %`;
      }
    }
    applyTransform(t.snap, M);
    this.requestRender();
  }

  endInkTransform(t, cancel = false) {
    this._inkDragItems = null;
    this.lastSnap = null;
    if (t.h.type === 'end') {
      if (cancel || !t.moved) {
        t.item.points = t.orig.points;
        if (t.orig.at) t.item.at = t.orig.at; else delete t.item.at;
      } else {
        setArrowEnd(t.item, t.h.i, t.attach || null);
        this.syncInkLinks();
        this.commit();
      }
    } else if (cancel || !t.moved) {
      restore(t.snap);
    } else {
      this.rebaseInk(t.items);
      this.commit();
    }
    this.refreshUI();
    this.requestRender();
  }

  /** Rotate 90° clockwise / flip the selected ink about its middle. */
  transformSelectedInk(kind) {
    const items = this.selectedStrokes();
    if (!items.length) return false;
    const b = unionBounds(items);
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const M = kind === 'rotate' ? rotateAbout(c, -Math.PI / 2)
      : kind === 'flipH' ? scaleAbout(c, -1, 1) : scaleAbout(c, 1, -1);
    applyTransform(snapshot(items), M);
    this.rebaseInk(items);
    this.commit(); this.refreshUI(); this.requestRender();
    return true;
  }

  /** Draws the box (or arrow handles) for the current selection. */
  _drawInkTransform(active) {
    const target = this._inkTransformTarget();
    if (!target) return;
    const k = this._handleScale();
    if (target.kind === 'arrow') { this.renderer.drawArrowHandles(target.item, k); return; }
    const box = this._inkBoxScreen(target.items);
    if (box) this.renderer.drawTransformBox(box.corners, box.turn, k, active?.label || null);
  }
}

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"/><path d="M14 4h5v5" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 4h5v5" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>')}") 12 12, crosshair`;

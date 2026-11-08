import { Arc, Circle, Line, Point } from '../core/entities.js';
import { Tool } from './tool.js';

export class SelectTool extends Tool {
  constructor(app) {
    super(app);
    this.dragging = null;
    this.box = null;
    this.boxMode = 'select';
  }
  hint() { return 'Click to select. Ctrl-click to add/remove. Drag to move. Click a selected driving dimension to edit.'; }
  onPointerDown(world, snap, ev) {
    // Dimension labels first — they sit "on top of" any underlying entity
    // and need their own select / edit / drag handling.
    const r = this.app.canvas.getBoundingClientRect();
    const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const dim = this.app.hitDimAtScreen(sx, sy);
    if (dim) {
      const wasSelected = !!dim.selected;
      const isToggle = ev.ctrlKey || ev.metaKey;
      const isAdd = ev.shiftKey;
      if (isToggle) {
        this.app.setSelected(dim, !wasSelected);
      } else {
        if (!isAdd && !wasSelected) this.app.clearSelection();
        this.app.setSelected(dim, true);
      }
      this.dimAction = dim.selected
        ? { constraint: dim, startWorld: world, moved: false,
            editOnClick: !isToggle && !isAdd && wasSelected && !dim.driven }
        : null;
      this.app.refreshUI();
      this.app.requestRender();
      return;
    }
    const hit = this.app.hitTestActiveSketch(world);
    const isToggle = ev.ctrlKey || ev.metaKey;
    const isAdd    = ev.shiftKey;
    if (this.app.operationName === 'mirror') {
      if (!hit && this.app.mirrorPickMode === 'entities') {
        this.boxMode = 'mirror';
        this.box = {
          x0: world.x, y0: world.y, x1: world.x, y1: world.y,
          replace: !isAdd && !isToggle,
          toggle: isToggle,
          sx0: sx, sy0: sy
        };
        this.app.requestRender();
        return;
      }
      this.app.handleMirrorPick(hit);
      return;
    }
    if (this.app.operationName === 'offset') {
      if (this.app.offsetPhase === 'typing') return;
      if (!hit) {
        this.boxMode = 'offset';
        this.box = {
          x0: world.x, y0: world.y, x1: world.x, y1: world.y,
          replace: !isAdd && !isToggle,
          sx0: sx, sy0: sy
        };
        this.app.requestRender();
        return;
      }
      this.app.handleOffsetPick(hit, world);
      return;
    }
    if (hit) {
      if (isToggle) this.app.setSelected(hit, !hit.selected);
      else if (isAdd) this.app.setSelected(hit, true);
      else if (!hit.selected) { this.app.clearSelection(); this.app.setSelected(hit, true); }
      else this.app.setSelected(hit, true);
      // collect drag points (only those on the active sketch)
      const activeId = this.app.project.activeSketchId;
      const pts = [];
      const seen = new Set();
      for (const s of this.app.project.sketches) {
        if (s.id !== activeId) continue;
        for (const e of s.entities) {
          const walk = (x, inheritSel) => {
            const sel = inheritSel || x.selected;
            if (x instanceof Point && sel && !x.fixed && !x.locked && !seen.has(x)) { seen.add(x); pts.push({ p:x, x:x.x, y:x.y }); }
            for (const c of x.children()) walk(c, sel);
          };
          walk(e, e.selected);
        }
      }
      const rigidLines = hit instanceof Line
        ? [{ lineId: hit.id, p1: hit.p1.id, p2: hit.p2.id, dx: hit.p2.x - hit.p1.x, dy: hit.p2.y - hit.p1.y }]
        : [];
      const sketch = this.app.activeSketch();
      const hitIsResizableCircle = hit instanceof Circle &&
        !sketch?.constraints.some(c => c.kind === 'radius' && c.circleId === hit.id);
      const canDrag = pts.length || hitIsResizableCircle;
      this.dragging = canDrag ? this.app.beginLocalizedDrag(world, pts, hit, rigidLines) : null;
      this.app.refreshUI();
      this.app.requestRender();
    } else {
      if (!isAdd && !isToggle) this.app.clearSelection();
      this.boxMode = 'select';
      this.box = { x0: world.x, y0: world.y, x1: world.x, y1: world.y };
      this.app.requestRender();
    }
  }
  onPointerMove(world, snap, ev) {
    if (this.app.operationName === 'offset' && this.app.offsetPhase === 'placing' && !this.dimAction && !this.dragging && !this.box) {
      this.app.updateOffsetCursor(world);
      return;
    }
    if (this.dimAction) {
      const dx = world.x - this.dimAction.startWorld.x;
      const dy = world.y - this.dimAction.startWorld.y;
      // Treat as a drag once the cursor moves a couple of pixels' worth.
      if (Math.hypot(dx, dy) * this.app.view.zoom > 3) this.dimAction.moved = true;
      if (this.dimAction.moved) {
        this.app.moveDimLabel(this.dimAction.constraint, world);
        this.app.requestRender();
      }
      return;
    }
    if (this.dragging) {
      // Pick a single "primary" handle to latch the cursor delta onto its
      // snap target — translation can only satisfy one alignment at a
      // time. The other handles still get a chance to contribute snap
      // constraints (see collectDragSnaps), they just won't be pulled
      // exactly onto their targets until release re-solves.
      let dx = world.x - this.dragging.startWorld.x;
      let dy = world.y - this.dragging.startWorld.y;
      let primary = null;
      let result = null;
      this.dragging.rejectedSnapKeys = new Set();
      if (snap && snap.dragRecord && !this.app.shouldIgnoreDragSnap(this.dragging, snap)) {
        const snapped = this.app._dragDeltaForSnap(this.dragging, snap);
        const beforeSnap = this.dragging.state ? this.app._captureParamValues(this.dragging.state) : null;
        result = this.app.solveLocalizedDrag(this.dragging, snapped.dx, snapped.dy);
        // Keep the snap only if the point really got onto it. A point held
        // by its constraints (e.g. on a fixed-length arm) may only be able
        // to aim at the target; then the snap is dropped for this frame and
        // the drag simply follows the cursor.
        if (result && result.ok && !result.rejected && this.app._snapReached(snap)) {
          dx = snapped.dx;
          dy = snapped.dy;
          primary = snap;
        } else {
          // Undo the attempt so the plain drag starts from where the
          // geometry was, not from wherever the snap solve left it.
          if (beforeSnap) this.app._applyParamValues(this.dragging.state, beforeSnap);
          snap.rejected = true;
          this.dragging.rejectedSnapKeys.add(this.app._snapKey(snap));
          this.app.lastSnap = null;
          result = null;
        }
      }
      if (!result) result = this.app.solveLocalizedDrag(this.dragging, dx, dy);
      // After the solve, probe each *other* handle at its now-final
      // position so secondary snaps (e.g. the far end of a dragged line
      // happening to fall on another line) light up too. This mirrors
      // creation, where each click contributes its own snap constraint.
      this.dragging.endSnaps = result?.rejected ? [] : this.app.collectDragSnaps(this.dragging, primary);
      this.app.lastDragSnaps = this.dragging.endSnaps;
      this.app.requestRender();
    } else if (this.box) {
      this.box.x1 = world.x; this.box.y1 = world.y;
      this.app.requestRender();
    } else {
      // Hover is edit affordance, so only the active sketch can light up.
      let changed = false;
      const r = this.app.canvas.getBoundingClientRect();
      const dim = ev ? this.app.hitDimAtScreen(ev.clientX - r.left, ev.clientY - r.top) : null;
      const hit = dim ? null : this.app.hitTestActiveSketch(world);
      if (this.hoverDim !== dim || this.hoverHit !== hit) { this.hoverDim = dim; this.hoverHit = hit; changed = true; }
      for (const s of this.app.project.visibleSketches()) {
        for (const e of s.entities) {
          const hov = e === hit;
          if (e.hover !== hov) { e.hover = hov; changed = true; }
          for (const c of e.children()) {
            const childHov = c === hit;
            if (c.hover !== childHov) { c.hover = childHov; changed = true; }
          }
        }
      }
      if (changed) this.app.requestRender();
    }
  }
  onPointerUp(world, snap, ev) {
    this.app.requestRender();                 // refresh the cursor (drag ended)
    if (this.dimAction) {
      if (this.dimAction.moved) {
        // The label position was mutated in-place during pointermove; just
        // commit so the change goes through the undo stack and persists.
        this.app.commit();
      } else {
        // No movement — treat as a click and open the inline editor.
        if (this.dimAction.editOnClick) this.app.editDimValue(this.dimAction.constraint);
      }
      this.dimAction = null;
      return;
    }
    if (this.box) {
      const wasOffsetBox = this.boxMode === 'offset';
      const wasMirrorBox = this.boxMode === 'mirror';
      const box = this.box;
      const x0 = Math.min(this.box.x0, this.box.x1);
      const y0 = Math.min(this.box.y0, this.box.y1);
      const x1 = Math.max(this.box.x0, this.box.x1);
      const y1 = Math.max(this.box.y0, this.box.y1);
      const movedPx = Math.hypot((world.x - box.x0) * this.app.view.zoom, (world.y - box.y0) * this.app.view.zoom);
      this.box = null;
      this.boxMode = 'select';

      if (wasOffsetBox && movedPx <= 3) {
        if (this.app.offsetEntityIds.length && this.app.offsetPhase === 'placing') {
          this.app.updateOffsetCursor(world);
          this.app._showOffsetInput();
        }
        return;
      }
      if (wasMirrorBox && movedPx <= 3) return;

      if (wasOffsetBox && box.replace) this.app.offsetEntityIds = [];
      else if (!wasMirrorBox && box.replace) this.app.clearSelection();

      const mirrorHits = [];
      for (const s of this.app.activeVisibleSketches()) {
        for (const e of s.entities) {
          if (!this.app.isEntityInteractive(e)) continue;
          const inBox = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
          let inside = false;
          if (e instanceof Line)        inside = inBox(e.p1) && inBox(e.p2);
          else if (e instanceof Circle) inside = inBox(e.center);
          else if (e instanceof Arc)    inside = inBox(e.center);
          else if (e instanceof Point)  inside = inBox(e);
          if (!inside) continue;
          if (wasOffsetBox) {
            if (e instanceof Line || e instanceof Circle || e instanceof Arc) {
              if (!this.app.offsetEntityIds.includes(e.id)) this.app.offsetEntityIds.push(e.id);
            }
          } else if (wasMirrorBox) {
            if (e instanceof Point || e instanceof Line || e instanceof Circle) mirrorHits.push(e);
          } else {
            this.app.setSelected(e, true);
          }
        }
      }
      if (wasOffsetBox) {
        this.app.offsetAnchorId = this.app.offsetEntityIds[0] || null;
        this.app.offsetPhase = this.app.offsetEntityIds.length ? 'placing' : 'selecting';
        this.app._syncOffsetSelection();
      } else if (wasMirrorBox) {
        this.app.handleMirrorBoxPick(mirrorHits, { replace: box.replace, toggle: box.toggle });
      } else {
        this.app.refreshUI();
      }
    }
    if (this.dragging) {
      // Promote every snap that was active at release into a real
      // constraint — same semantics as creation, where each independent
      // snap-on-click produces its own constraint. Dedupe against
      // existing constraints so dragging a handle back to where it
      // already came from doesn't pile on redundant ones.
      // Only snaps the dragged point actually reached count: a point held
      // by its constraints stays put even when the cursor lands on a
      // target, and a constraint must describe where the point is. Each
      // one is test-solved before it is kept (admitConstraint).
      const sketch = this.app.activeSketch();
      const snaps = this.dragging.endSnaps || [];
      if (sketch && snaps.length) {
        for (const sn of snaps) {
          const pt = sn.dragPoint || (this.dragging.pts.length === 1 ? this.dragging.pts[0].p : null);
          if (!pt || sn.entity === pt) continue;
          if (this.app.shouldIgnoreDragSnap(this.dragging, sn)) continue;
          if (!this.app._snapReached({ ...sn, dragPoint: pt })) continue;
          const c = this.app.snapToConstraint(sn, pt);
          if (!c) continue;
          this.app.admitConstraint(sketch, c);
        }
      }
      this.dragging = null;
      this.app.lastDragSnaps = [];
      this.app.commit();
    }
  }
  onKey(ev) {
    if (ev.key === 'Delete' || ev.key === 'Backspace') { this.app.deleteSelection(); ev.preventDefault(); }
    else if (ev.key === 'Escape') {
      if (this.app.cancelOperation()) {
        ev.preventDefault();
      } else {
        this.app.clearSelection();
      }
    }
  }
  getPreview() {
    if (!this.box) return null;
    const v = this.app.view;
    const a = v.worldToScreen({x:this.box.x0, y:this.box.y0});
    const b = v.worldToScreen({x:this.box.x1, y:this.box.y1});
    return { box: { x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), w: Math.abs(a.x-b.x), h: Math.abs(a.y-b.y) } };
  }
}

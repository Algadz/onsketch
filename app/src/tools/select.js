import { Arc, Bezier, Circle, Line, Point } from '../core/entities.js';
import { bezierBBox } from '../core/bezier.js';
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
    // "Link to…" is waiting for its target: this click picks it.
    if (this.app.linkPick) { this.app.handleLinkPick(world); return; }
    // Dimension labels first — they sit "on top of" any underlying entity
    // and need their own select / edit / drag handling.
    const r = this.app.canvas.getBoundingClientRect();
    const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    // Handles of selected ink: resize / turn box, or the ends of an arrow.
    const handle = ev.button === 0 || ev.button == null ? this.app.hitInkHandle(sx, sy) : null;
    if (handle) {
      this.inkTransform = this.app.beginInkTransform(handle, world);
      this.arrowEnd = handle.type === 'end';
      return;
    }
    // Relation badges: click to select (Delete removes the relation).
    // A tap on a selected dimension edits it, even when a relation badge
    // is within reach (finger hit areas are larger and overlap).
    const selDim = this.app.hitDimAtScreen(sx, sy);
    const rel = selDim?.selected ? null : this.app.hitRelationAtScreen(sx, sy);
    if (rel) {
      const isToggle = ev.ctrlKey || ev.metaKey || this.app.multiSelect;
      if (isToggle) this.app.setSelected(rel, !rel.selected);
      else {
        if (!ev.shiftKey && !rel.selected) this.app.clearSelection();
        this.app.setSelected(rel, true);
      }
      this.app.refreshUI();
      this.app.requestRender();
      return;
    }
    const dim = selDim;
    if (dim) {
      const wasSelected = !!dim.selected;
      const isToggle = ev.ctrlKey || ev.metaKey || this.app.multiSelect;
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
    // Any visible shape (the active layer's win where they overlap).
    const hit = this.app.hitTestActiveSketch(world);
    const isToggle = ev.ctrlKey || ev.metaKey || this.app.multiSelect;
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
    if (this.app.operationName === 'pattern' && this.app.pattern) {
      // Empty canvas: a box (seeds, targets) or a click (new centre / target).
      const pick = this.app.pattern.pick;
      if (!hit && (pick === 'seeds' || pick === 'targets')) {
        this.boxMode = 'pattern';
        this.box = {
          x0: world.x, y0: world.y, x1: world.x, y1: world.y,
          replace: pick === 'seeds' && !isAdd && !isToggle,
          toggle: isToggle,
          sx0: sx, sy0: sy
        };
        this.app.requestRender();
        return;
      }
      this.app.handlePatternPick(hit, world);
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
      // collect drag points (selected shapes on visible layers)
      const activeId = this.app.project.activeSketchId;
      const pts = [];
      const seen = new Set();
      for (const s of this.app.project.sketches) {
        if (s.id !== activeId) continue;
        for (const e of s.entities) {
          if (!this.app.isEntityInteractive(e)) continue;
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
      if (this.dragging) this.dragging.restShapes = this.app._captureRestShapes();   // drag snaps skip what moves
      this.inkDrag = this.app.beginInkDrag(world);           // selected ink moves along
      this.app.refreshUI();
      this.app.requestRender();
    } else if (this.app.hitStrokeAt(world)) {
      const ink = this.app.hitStrokeAt(world);
      if (isToggle) this.app.selectInk(ink, !ink.selected);
      else if (isAdd) this.app.selectInk(ink, true);
      else if (!ink.selected) { this.app.clearSelection(); this.app.selectInk(ink, true); }
      this.inkDrag = ink.selected ? this.app.beginInkDrag(world) : null;
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
    if (this.inkTransform) { this.app.updateInkTransform(this.inkTransform, world, snap, ev); return; }
    if (this.app.linkPick) {
      const target = this.app.hitAnchorAt(world);
      this.app._setHoverTarget(target);
      this.app.canvas.style.cursor = target ? 'pointer' : 'crosshair';
      return;
    }
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
    if (this.inkDrag) this.app.dragInk(this.inkDrag, world);
    if (this.inkDrag && !this.dragging) return;
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
      this.app.updateLinkedDimensionsDuringDrag(this.dragging);
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
      // Hover: any visible shape.
      let changed = false;
      const hit = this.app.hitTestActiveSketch(world);
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
      // Ink is selectable and movable: show it under the cursor; handles
      // of selected ink show what they do.
      const r = this.app.canvas.getBoundingClientRect();
      const hc = ev ? this.app.inkHandleCursor(this.app.hitInkHandle(ev.clientX - r.left, ev.clientY - r.top)) : null;
      this.app.canvas.style.cursor = hc || (!hit && this.app.hitStrokeAt(world) ? 'move' : 'default');
    }
  }
  onPointerUp(world, snap, ev) {
    if (this.inkTransform) {
      const t = this.inkTransform;
      if (t.h.type === 'end' && world) this.app.updateInkTransform(t, world, snap, ev);
      this.inkTransform = null; this.arrowEnd = false;
      this.app.endInkTransform(t);
      return;
    }
    if (this.inkDrag) {
      const moved = this.inkDrag.moved;
      this.app.endInkDrag(this.inkDrag);
      this.inkDrag = null;
      if (moved && !this.dragging) { this.app.commit(); this.app.refreshUI(); return; }
    }
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
      const wasPatternBox = this.boxMode === 'pattern';
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
      if (wasPatternBox && movedPx <= 3) {
        // A click on empty canvas: a new target (or nothing for seeds).
        if (this.app.pattern?.pick === 'targets') this.app.handlePatternPick(null, { x: box.x0, y: box.y0 });
        return;
      }

      if (wasOffsetBox && box.replace) this.app.offsetEntityIds = [];
      else if (!wasMirrorBox && !wasPatternBox && box.replace) this.app.clearSelection();

      const mirrorHits = [];
      for (const s of this.app.activeVisibleSketches()) {
        for (const e of s.entities) {
          if (!this.app.isEntityInteractive(e)) continue;
          const inBox = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
          let inside = false;
          if (e instanceof Line)        inside = inBox(e.p1) && inBox(e.p2);
          else if (e instanceof Circle) inside = inBox(e.center);
          else if (e instanceof Arc)    inside = inBox(e.center);
          else if (e instanceof Bezier) { const b = bezierBBox(e.ctrl()); inside = inBox({ x: b.minX, y: b.minY }) && inBox({ x: b.maxX, y: b.maxY }); }
          else if (e instanceof Point)  inside = inBox(e);
          if (!inside) continue;
          if (wasOffsetBox) {
            if (e instanceof Line || e instanceof Circle || e instanceof Arc) {
              if (!this.app.offsetEntityIds.includes(e.id)) this.app.offsetEntityIds.push(e.id);
            }
          } else if (wasMirrorBox) {
            if (e instanceof Point || e instanceof Line || e instanceof Circle || e instanceof Bezier) mirrorHits.push(e);
          } else if (wasPatternBox) {
            mirrorHits.push(e);
          } else {
            this.app.setSelected(e, true);
          }
        }
      }
      if (!wasOffsetBox && !wasMirrorBox && !wasPatternBox) for (const st of this.app.strokesInBox(x0, y0, x1, y1)) this.app.setStrokeSelected(st, true);
      if (wasOffsetBox) {
        this.app.offsetAnchorId = this.app.offsetEntityIds[0] || null;
        this.app.offsetPhase = this.app.offsetEntityIds.length ? 'placing' : 'selecting';
        this.app._syncOffsetSelection();
      } else if (wasMirrorBox) {
        this.app.handleMirrorBoxPick(mirrorHits, { replace: box.replace, toggle: box.toggle });
      } else if (wasPatternBox) {
        this.app.handlePatternBoxPick(mirrorHits, { replace: box.replace, toggle: box.toggle });
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
      if (this.inkTransform) {
        const t = this.inkTransform;
        this.inkTransform = null; this.arrowEnd = false;
        this.app.endInkTransform(t, true);
        ev.preventDefault();
      } else if (this.app.cancelLinkPick()) {
        ev.preventDefault();
      } else if (this.app.cancelOperation()) {
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

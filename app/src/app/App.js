import { CONSTRAINT_LABELS } from '../core/constraints.js';
import { Arc, Circle, Line, Point, newId } from '../core/entities.js';
import { ArcEndpointArcEndpointCoincidentConstraint, ArcEndpointCoincidentConstraint, ArcEndpointFixConstraint, ArcEndpointMidpointConstraint, ArcEndpointOnCircleConstraint, ArcEndpointOnLineConstraint, CoincidentConstraint, FixConstraint, HorizontalConstraint, MidpointConstraint, PointOnCircleConstraint, PointOnLineConstraint, PointRefHorizontalConstraint, PointRefVerticalConstraint, VerticalConstraint } from '../core/constraints.js';
import { Solver } from '../core/solver.js';
import { Project } from '../core/model.js';
import { View } from '../render/view.js';
import { Renderer } from '../render/renderer.js';
import { SnapEngine } from '../editor/snap.js';
import { SelectTool } from '../tools/select.js';
import { DimensionLabelsMixin } from './dimensions.js';
import { SelectionMixin } from './selection.js';
import { DragMixin } from './drag.js';
import { SolveMixin } from './solve.js';
import { OperationsMixin } from './operations.js';
import { ConstraintActionsMixin } from './constraint-actions.js';
import { RenderEventsMixin } from './render-events.js';
import { PanelsMixin } from './panels.js';
import { ChromeMixin } from './chrome.js';
import { EquationsMixin } from './equations-ui.js';
import { LayersPanelMixin } from './layers-panel.js';
import { FillsMixin } from './fills.js';
import { PersistenceMixin } from './persistence.js';
import { SketchWindowMixin } from './sketch-window.js';

/* =============== 10. APP ====================================== */
export class App {
  constructor() {
    this.project = new Project();
    this.project.addSketch('Sketch 1');
    this.view = new View();
    this.canvas = document.getElementById('canvas');
    this.renderer = new Renderer(this.canvas, this.view);
    this.snap = new SnapEngine();
    this.snap.entityFilter = (e) => this.isEntityVisible(e);
    this.solver = new Solver();
    this.tool = new SelectTool(this);
    this.toolName = 'select';
    this.operationName = null;
    this.mirrorPickMode = 'entities';
    this.mirrorEntityIds = [];
    this.mirrorAxisId = null;
    this.offsetEntityIds = [];
    this.offsetAnchorId = null;
    this.offsetPhase = 'selecting';
    this.offsetDistance = 10;
    this.offsetSide = 1;
    this.offsetInputEl = null;
    this.polygonSides = 6;
    this.gridOn = true; this.snapOn = true; this.constructionMode = false;
    this.lastSnap = null; this.lastWorldCursor = { x:0, y:0 };
    // While a drag is in progress, this holds *every* snap that is
    // currently active across all dragged handles (primary + secondaries).
    // The renderer draws a marker for each so the user sees, before
    // releasing, which snap constraints will be added.
    this.lastDragSnaps = [];
    this.selectionOrder = [];
    this.dirty = true;
    this.undoStack = []; this.redoStack = [];
    this._diagnosticsToken = 0;
    this._diagnosticsFrame = null;
    this._diagnosticsTimer = null;
    this._diagnosticsIdleId = null;
    this.contextMenuEl = null;
    this.contextMenuDocPointerDown = null;

    this._setupCanvasEvents();
    this._setupKeyboard();
    this._setupChrome();
    this._setupSidebar();
    this._setupLayersPanel();
    this._setupEquationsPanel();
    this.renderer.labelFor = (c, text) => this.dimensionLabel(c, text);
    this._setupModal();
    this._setupResize();
    const restored = this.loadLocalIfAny();
    this._setupAutosave();
    this.refreshUI();
    this.solveAndRender();
    if (restored) { this._primeFillRegions(); this.zoomFit(); }
    this._loop();
  }

  /* ---- Project ---- */
  /** Every project swap (new, import, undo/redo) goes through here so
   *  new geometry keeps getting the current drawing style. */
  get project() { return this._project; }
  set project(p) {
    this._project = p;
    if (p) p.drawStyle = this.pen ? this._penStyle() : null;
  }

  /* ---- Sketch helpers ---- */
  activeSketch() { return this.project.active(); }
  visibleSketches() { return this.project.visibleSketches(); }
  activeVisibleSketches() {
    const s = this.activeSketch();
    return (s && s.visible) ? [s] : [];
  }

  /* ---- Layer visibility / lock ---- */
  /** Entity's layer is shown (hidden layers are still solved). */
  isEntityVisible(e) { const l = this.project.layerOf(e); return !l || l.visible; }
  /** Entity can be hovered, picked and box-selected: only geometry on the
   *  active layer, and only while that layer is visible.
   *  (Snapping still uses every visible layer.) */
  isEntityInteractive(e) {
    const l = this.project.layerOf(e);
    return !!l && l.id === this.project.activeLayerId && l.visible;
  }

  /** Layer a constraint belongs to (its own layerId, set when created). */
  constraintLayer(c) {
    return this.project.layer(c.layerId) || this.project.activeLayer();
  }
  /** 'active' (shown, selectable), 'inactive' (shown grey) or 'hidden'. */
  constraintLayerState(c) {
    const l = this.constraintLayer(c);
    if (!l.visible) return 'hidden';
    return l.id === this.project.activeLayerId ? 'active' : 'inactive';
  }

  makeOrReusePoint(world, snap, sketch) {
    // Endpoint snaps return the snapped Point directly so callers share
    // an existing corner only inside the active sketch. Endpoints from
    // inactive sketches stay reference geometry, so we create a new active
    // point and constrain it to the reference instead of sharing the object.
    // Only a point of the active layer is shared; on another layer a new
    // point is made and the caller ties it with a coincident constraint,
    // so the layers stay independent.
    if (snap && snap.kind === 'endpoint' && snap.entity instanceof Point && !this.arcEndpointRef(snap.entity)) {
      const owner = this.project.ownerOf(snap.entity);
      if (owner && sketch.entities.includes(owner) && this.project.layerOf(owner).id === this.project.activeLayerId) {
        return { point: snap.entity, reused: true };
      }
    }
    const wx = snap ? snap.x : world.x;
    const wy = snap ? snap.y : world.y;
    return { point: new Point(wx, wy), reused: false };
  }

  arcEndpointRef(point) {
    const arc = point && point.arcOwner;
    if (!(arc instanceof Arc) || (point.arcEndpoint !== 'start' && point.arcEndpoint !== 'end')) return null;
    return { arcId: arc.id, centerId: arc.center.id, which: point.arcEndpoint };
  }

  /** Translate a snap result into the constraint that should pin a freshly
   *  created Point to the snapped feature. Returns null if no constraint
   *  applies. The constraint is added by the caller AFTER the new point's
   *  parent entity has been added to the sketch (so the solver lookup can
   *  find the new id). */
  snapToConstraint(snap, point) {
    if (!snap) return null;
    const endpointRef = this.arcEndpointRef(point);
    const snapEndpointRef = this.arcEndpointRef(snap.entity);
    if (snap.kind === 'endpoint' && snapEndpointRef && !endpointRef) {
      return new ArcEndpointCoincidentConstraint(snapEndpointRef, point.id);
    }
    if (endpointRef) {
      if (snap.kind === 'endpoint' && snap.entity instanceof Point && snap.entity !== point) {
        if (snapEndpointRef) return new ArcEndpointArcEndpointCoincidentConstraint(endpointRef, snapEndpointRef);
        return new ArcEndpointCoincidentConstraint(endpointRef, snap.entity.id);
      }
      if (snap.kind === 'origin') return new ArcEndpointFixConstraint(endpointRef, 0, 0);
      if (snap.kind === 'midpoint' && snap.entity instanceof Line) {
        return new ArcEndpointMidpointConstraint(endpointRef, { a: snap.entity.p1.id, b: snap.entity.p2.id });
      }
      if (snap.kind === 'center' && snap.entity && snap.entity.center) {
        return new ArcEndpointCoincidentConstraint(endpointRef, snap.entity.center.id);
      }
      if (snap.kind === 'on-line' && snap.entity instanceof Line) {
        return new ArcEndpointOnLineConstraint(endpointRef, { a: snap.entity.p1.id, b: snap.entity.p2.id });
      }
      if ((snap.kind === 'on-circle' || snap.kind === 'quadrant') && snap.entity && (snap.entity instanceof Circle || snap.entity instanceof Arc)) {
        return new ArcEndpointOnCircleConstraint(endpointRef, snap.entity.id, snap.entity.center.id);
      }
    }
    if (snap.kind === 'endpoint' && snap.entity instanceof Point && snap.entity !== point) {
      return new CoincidentConstraint(point.id, snap.entity.id);
    }
    if (snap.kind === 'origin') {
      point.fixed = true;
      return new FixConstraint(point.id, 0, 0);
    }
    if (snap.kind === 'midpoint' && snap.entity instanceof Line) {
      return new MidpointConstraint(point.id, { a: snap.entity.p1.id, b: snap.entity.p2.id });
    }
    if (snap.kind === 'center' && snap.entity && snap.entity.center) {
      return new CoincidentConstraint(point.id, snap.entity.center.id);
    }
    if (snap.kind === 'quadrant' && snap.entity && (snap.entity instanceof Circle || snap.entity instanceof Arc)) {
      return new PointOnCircleConstraint(point.id, snap.entity.id, snap.entity.center.id);
    }
    if (snap.kind === 'on-line' && snap.entity instanceof Line) {
      return new PointOnLineConstraint(point.id, { a: snap.entity.p1.id, b: snap.entity.p2.id });
    }
    if (snap.kind === 'on-circle' && snap.entity && (snap.entity instanceof Circle || snap.entity instanceof Arc)) {
      return new PointOnCircleConstraint(point.id, snap.entity.id, snap.entity.center.id);
    }
    return null;
  }

  _pointRef(point) {
    return this.arcEndpointRef(point) || { pointId: point.id };
  }

  _fixConstraintForPoint(point) {
    const ref = this.arcEndpointRef(point);
    return ref ? new ArcEndpointFixConstraint(ref, point.x, point.y) : new FixConstraint(point.id, point.x, point.y);
  }

  _coincidentConstraintForPoints(a, b) {
    const ar = this.arcEndpointRef(a);
    const br = this.arcEndpointRef(b);
    if (ar && br) return new ArcEndpointArcEndpointCoincidentConstraint(ar, br);
    if (ar) return new ArcEndpointCoincidentConstraint(ar, b.id);
    if (br) return new ArcEndpointCoincidentConstraint(br, a.id);
    return new CoincidentConstraint(a.id, b.id);
  }

  _axisConstraintForPoints(kind, a, b) {
    const ar = this.arcEndpointRef(a);
    const br = this.arcEndpointRef(b);
    if (ar || br) {
      const C = kind === 'horizontal' ? PointRefHorizontalConstraint : PointRefVerticalConstraint;
      return new C(this._pointRef(a), this._pointRef(b));
    }
    const C = kind === 'horizontal' ? HorizontalConstraint : VerticalConstraint;
    return new C(newId('virt'), a.id, b.id);
  }

  _midpointConstraintForPoint(point, line) {
    const ref = this.arcEndpointRef(point);
    const l = { a: line.p1.id, b: line.p2.id };
    return ref ? new ArcEndpointMidpointConstraint(ref, l) : new MidpointConstraint(point.id, l);
  }

  _pointOnLineConstraintForPoint(point, line) {
    const ref = this.arcEndpointRef(point);
    const l = { a: line.p1.id, b: line.p2.id };
    return ref ? new ArcEndpointOnLineConstraint(ref, l) : new PointOnLineConstraint(point.id, l);
  }

  _pointOnCircleConstraintForPoint(point, curve) {
    const ref = this.arcEndpointRef(point);
    return ref
      ? new ArcEndpointOnCircleConstraint(ref, curve.id, curve.center.id)
      : new PointOnCircleConstraint(point.id, curve.id, curve.center.id);
  }

  pointsCoincidentInSketch(sketch, a, b) {
    if (!sketch || !a || !b) return false;
    if (a === b || a.id === b.id) return true;
    const parent = new Map();
    const find = (id) => {
      if (!parent.has(id)) parent.set(id, id);
      while (parent.get(id) !== id) {
        parent.set(id, parent.get(parent.get(id)));
        id = parent.get(id);
      }
      return id;
    };
    const union = (x, y) => {
      const rx = find(x), ry = find(y);
      if (rx !== ry) parent.set(rx, ry);
    };
    for (const e of sketch.entities) {
      for (const p of e.children()) if (p instanceof Point) find(p.id);
      if (e instanceof Point) find(e.id);
    }
    for (const c of sketch.constraints) {
      if (c.kind === 'coincident') union(c.p1, c.p2);
    }
    return find(a.id) === find(b.id);
  }

  /** Constraints that can't mean anything: a point tied to itself, to a
   *  line or arc it is an end of, or to its own circle's centre; a
   *  coincidence between the two ends of one line. */
  _isInvalidConstraint(sketch, c) {
    if (!sketch || !c) return false;
    const lineHas = (l, id) => l && (l.a === id || l.b === id);
    switch (c.kind) {
      case 'coincident': {
        if (c.p1 === c.p2) return true;
        for (const e of sketch.entities) {
          if (e instanceof Line && ((c.p1 === e.p1.id && c.p2 === e.p2.id) || (c.p1 === e.p2.id && c.p2 === e.p1.id))) return true;
        }
        return false;
      }
      case 'pointOnLine':
      case 'midpoint':
        return lineHas(c.l, c.pointId);
      case 'pointOnCircle':
        return c.pointId === c.centerId || c.pointId === c.circleId;
      case 'arcEndpointCoincident':
      case 'arcEndpointOnLine':
      case 'arcEndpointMidpoint':
      case 'arcEndpointOnCircle': {
        const arc = this._lookupAny(c.ref?.arcId);
        const own = arc ? [arc.start?.id, arc.end?.id, arc.center?.id] : [];
        if (c.pointId && own.includes(c.pointId)) return true;
        if (c.l && (own.includes(c.l.a) || own.includes(c.l.b))) return true;
        if (c.circleId && c.circleId === c.ref?.arcId) return true;
        return false;
      }
      case 'arcEndpointArcEndpointCoincident':
        return c.ref1?.arcId === c.ref2?.arcId && c.ref1?.which === c.ref2?.which;
    }
    return false;
  }

  /**
   * Add a constraint only if it keeps the sketch solvable: it must not be
   * meaningless, a duplicate, already implied by other constraints, or in
   * conflict with them. A trial solve decides; the geometry is put back
   * afterwards either way (the caller's commit does the real solve).
   * @returns {boolean} whether it was added
   */
  admitConstraint(sketch, c, { quiet = false } = {}) {
    if (!sketch || !c) return false;
    if (this._isInvalidConstraint(sketch, c) || this._isDuplicateConstraint(sketch, c)) return false;
    const before = this._captureSketchParams(sketch);
    sketch.constraints.push(c);
    const probe = this.solver.solve(sketch, this.project.sketches, [], { diagnostics: true, activeIds: c.refs() });
    this._restoreSketchParams(before);
    for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
    let conflict = !probe.ok || probe.state === 'over';
    const implied = probe.redundantIds && probe.redundantIds.has(c.id);
    if (conflict) {
      // Only blame this constraint if the sketch solved without it.
      sketch.constraints.pop();
      const base = this.solver.solve(sketch, this.project.sketches, [], { diagnostics: false, activeIds: c.refs() });
      this._restoreSketchParams(before);
      for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
      sketch.constraints.push(c);
      if (!base.ok) conflict = false;
    }
    if (conflict || implied) {
      sketch.constraints.pop();
      if (c.kind === 'fix' && !sketch.constraints.some(k => k.kind === 'fix' && k.pointId === c.pointId)) {
        const p = this._lookupAny(c.pointId);
        if (p) p.fixed = false;
      }
      if (!quiet && conflict) {
        const label = CONSTRAINT_LABELS[c.kind] || c.kind;
        document.getElementById('status-hint').textContent =
          `${label} not added: it conflicts with the existing constraints (the sketch would be over-defined).`;
      }
      return false;
    }
    return true;
  }


  /** Hit test that walks ALL visible sketches. Children (points) win
   *  over their parent entities so endpoint dragging works. */
  hitTestAcrossLayers(world) {
    return this.hitTestSketches(world, this.project.visibleSketches());
  }

  hitTestActiveSketch(world) {
    return this.hitTestSketches(world, this.activeVisibleSketches());
  }

  hitTestSketches(world, sketches) {
    const v = this.view;
    // Prefer points first, then larger entities. Standalone Point
    // entities, such as centerline midpoints, must win over line bodies.
    for (const s of sketches) {
      for (const e of s.entities) {
        if (!this.isEntityInteractive(e)) continue;
        for (const c of e.children()) if (c.hit(world, v)) return c;
        if (e instanceof Point && e.hit(world, v)) return e;
      }
    }
    for (const s of sketches) {
      for (const e of s.entities) if (!(e instanceof Point) && this.isEntityInteractive(e) && e.hit(world, v)) return e;
    }
    return null;
  }

  hitTestAllSketches(world, sketches) {
    const v = this.view;
    const out = [];
    const seen = new Set();
    const add = (e) => {
      if (!e || seen.has(e)) return;
      seen.add(e);
      out.push(e);
    };
    for (const s of sketches) {
      for (const e of s.entities) {
        if (!this.isEntityInteractive(e)) continue;
        for (const c of e.children()) if (c.hit(world, v)) add(c);
        if (e instanceof Point && e.hit(world, v)) add(e);
      }
    }
    for (const s of sketches) {
      for (const e of s.entities) {
        if (!(e instanceof Point) && this.isEntityInteractive(e) && e.hit(world, v)) add(e);
      }
    }
    return out;
  }

  hitTestForDimension(world) {
    // Smart Dimension picks any visible entity. Whether the constraint
    // can actually be added is checked downstream.
    return this.hitTestAcrossLayers(world);
  }

  _setHoverTarget(target) {
    let changed = false;
    for (const s of this.project.visibleSketches()) {
      for (const e of s.entities) {
        const hov = e === target;
        if (e.hover !== hov) { e.hover = hov; changed = true; }
        for (const c of e.children()) {
          const childHov = c === target;
          if (c.hover !== childHov) { c.hover = childHov; changed = true; }
        }
      }
    }
    if (changed) this.requestRender();
  }

  _contextMenuGlyph(e) {
    if (e instanceof Point) return 'P';
    if (e instanceof Line) return 'L';
    if (e instanceof Circle) return 'C';
    if (e instanceof Arc) return 'A';
    return '?';
  }

  _selectFromContextMenu(item, ev) {
    const toggle = ev.ctrlKey || ev.metaKey;
    const add = ev.shiftKey;
    if (toggle) {
      this.setSelected(item, !item.selected);
    } else {
      if (!add) this.clearSelection();
      this.setSelected(item, true);
    }
    this.hideContextMenu();
    this.refreshUI();
    this.requestRender();
  }

  showContextMenu(screen, world, ev) {
    this.hideContextMenu();
    const items = this.hitTestAllSketches(world, this.activeVisibleSketches());
    if (!items.length) return false;

    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    menu.addEventListener('mouseleave', () => this._setHoverTarget(null));

    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'context-menu-item';
      row.innerHTML = `
        <span class="glyph">${this._contextMenuGlyph(item)}</span>
        <span>${this._entityLabel(item)}</span>
        <span class="meta">${item.construction ? 'construction' : item.fixed ? 'fixed' : ''}</span>
      `;
      row.addEventListener('mouseenter', () => this._setHoverTarget(item));
      row.addEventListener('click', e => this._selectFromContextMenu(item, e));
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(ev.clientX, window.innerWidth - rect.width - margin);
    const top = Math.min(ev.clientY, window.innerHeight - rect.height - margin);
    menu.style.left = Math.max(margin, left) + 'px';
    menu.style.top = Math.max(margin, top) + 'px';
    this.contextMenuEl = menu;
    this._setHoverTarget(items[0]);

    this.contextMenuDocPointerDown = (e) => {
      if (this.contextMenuEl && !this.contextMenuEl.contains(e.target)) this.hideContextMenu();
    };
    setTimeout(() => document.addEventListener('pointerdown', this.contextMenuDocPointerDown), 0);
    return true;
  }

  hideContextMenu() {
    if (this.contextMenuDocPointerDown) {
      document.removeEventListener('pointerdown', this.contextMenuDocPointerDown);
      this.contextMenuDocPointerDown = null;
    }
    if (this.contextMenuEl) {
      this.contextMenuEl.remove();
      this.contextMenuEl = null;
    }
    this._setHoverTarget(null);
  }

  /** Snap is only meaningful while you're actively placing or moving
   *  geometry. In plain Select mode (no drag in progress) and while using
   *  Smart Dim (which hit-tests entities, not snap points), we suppress
   *  snap detection so no markers or "endpoint / on-line / on-circle"
   *  hints flash at the cursor. */
  _snapForCurrentTool(world) {
    if (!this.snapOn) return null;
    const drawing = ['line','centerLine','rectangle','centerRectangle','circle','threePointCircle','hexagon','arc','point'].includes(this.toolName);
    const dragging = this.toolName === 'select' && this.tool && this.tool.dragging;
    if (!drawing && !dragging) return null;
    if (dragging) return this._snapForDragging(world);
    return this.snap.find(world, this.view, this.visibleSketches());
  }

  /** Dragged points plus every line / arc / circle they belong to: a
   *  dragged point can't meaningfully snap onto its own geometry. */
  _dragSnapExclusions(drag) {
    if (drag._snapExclusions) return drag._snapExclusions;
    const set = new Set(drag.pts.map(r => r.p));
    const sketch = this.activeSketch();
    if (sketch) for (const e of sketch.entities) if (e.children().some(c => set.has(c))) set.add(e);
    drag._snapExclusions = set;
    return set;
  }

  _snapForDragging(world) {
    const drag = this.tool?.dragging;
    if (!drag) return null;
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    const draggedSet = this._dragSnapExclusions(drag);
    const handles = drag.snapPts || drag.pts;
    let best = null;
    for (const r of handles) {
      const probe = this._dragPreviewPoint(drag, r, dx, dy);
      const snap = this.snap.find(probe, this.view, this.visibleSketches(), {
        ignore: (candidate) =>
          (candidate.entity && draggedSet.has(candidate.entity)) ||
          this.shouldIgnoreDragSnap(drag, candidate)
      });
      if (!snap) continue;
      const ranked = { ...snap, dragPoint: r.p, dragRecord: r };
      if (!best || ranked._p > best._p || (ranked._p === best._p && ranked._d < best._d)) best = ranked;
    }
    return best;
  }

  /** Mirror creation behavior on drag: every dragged handle that ends up
   *  on a snap target should produce its own constraint, just like every
   *  click during creation produces its own. The primary snap (already
   *  used to latch the cursor delta) is one of them; the rest come from
   *  probing each *other* handle at its post-solve final position. The
   *  user sees a marker for every entry in the returned list. */
  /** True when a drag snap's point actually sits on the snap target
   *  (within 3 screen pixels). A point held by its constraints may be
   *  unable to get there; such a snap must neither pull the drag nor be
   *  shown, nor become a constraint on release. */
  _snapReached(snap) {
    const p = snap && snap.dragPoint;
    return !!p && Math.hypot(p.x - snap.x, p.y - snap.y) * this.view.zoom <= 3;
  }

  collectDragSnaps(drag, primary) {
    if (!drag || !this.snapOn) return [];
    const out = [];
    const usedHandles = new Set();
    if (primary) {
      out.push(primary);
      if (primary.dragRecord) usedHandles.add(primary.dragRecord);
    }
    const draggedSet = this._dragSnapExclusions(drag);
    const handles = drag.snapPts || drag.pts;
    for (const r of handles) {
      if (usedHandles.has(r)) continue;
      // r.p has been mutated by solveLocalizedDrag to its final position
      // for this drag step, regardless of mode (rigid/dof/rotate/...).
      const probe = { x: r.p.x, y: r.p.y };
      const snap = this.snap.find(probe, this.view, this.visibleSketches(), {
        ignore: (candidate) =>
          (candidate.entity && draggedSet.has(candidate.entity)) ||
          this.shouldIgnoreDragSnap(drag, candidate)
      });
      if (!snap) continue;
      if (drag.rejectedSnapKeys && drag.rejectedSnapKeys.has(this._snapKey(snap))) continue;
      if (!this._snapReached({ ...snap, dragPoint: r.p })) continue;   // near, but not on it
      // It's fine if a secondary picks up the same feature as the primary
      // — e.g. dragging both endpoints of a line onto the same reference
      // line gives two distinct PointOnLine constraints (different points,
      // same line). Duplicate detection at release time deals with the
      // pathological case.
      out.push({ ...snap, dragPoint: r.p, dragRecord: r });
      usedHandles.add(r);
    }
    return out;
  }

  /** True if `sketch.constraints` already contains a constraint of the
   *  same kind referencing the exact same set of entity ids. Prevents
   *  drag from piling on a duplicate Coincident / PointOnLine / etc.
   *  when the user drags an already-constrained handle back onto its
   *  reference. */
  _isDuplicateConstraint(sketch, c) {
    if (!c || !sketch) return false;
    const key = (x) => {
      const o = x.toJSON ? x.toJSON() : { kind:x.kind, refs:x.refs() };
      const { id, ...rest } = o;
      return JSON.stringify(rest);
    };
    const exactKinds = new Set(['arcEndpointCoincident', 'arcEndpointArcEndpointCoincident', 'arcEndpointFix', 'arcEndpointMidpoint', 'arcEndpointOnLine', 'arcEndpointOnCircle', 'pointRefHorizontal', 'pointRefVertical', 'curveDistance', 'offset', 'offsetDistance']);
    if (exactKinds.has(c.kind)) {
      const aExact = key(c);
      return sketch.constraints.some(ex => ex.kind === c.kind && key(ex) === aExact);
    }
    const a = [...c.refs()].sort().join('|');
    for (const ex of sketch.constraints) {
      if (ex.kind !== c.kind) continue;
      const b = [...ex.refs()].sort().join('|');
      if (a === b) return true;
    }
    return false;
  }
}

/* Methods are grouped into mixins by concern; see src/app/*.js. */
for (const Mixin of [ChromeMixin, EquationsMixin, LayersPanelMixin, FillsMixin, DimensionLabelsMixin, SelectionMixin, DragMixin, SolveMixin, OperationsMixin, ConstraintActionsMixin, RenderEventsMixin, PanelsMixin, PersistenceMixin, SketchWindowMixin]) {
  for (const key of Object.getOwnPropertyNames(Mixin.prototype)) {
    if (key === 'constructor') continue;
    Object.defineProperty(App.prototype, key, Object.getOwnPropertyDescriptor(Mixin.prototype, key));
  }
}

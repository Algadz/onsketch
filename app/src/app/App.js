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
import { PersistenceMixin } from './persistence.js';

/* =============== 10. APP ====================================== */
export class App {
  constructor() {
    this.project = new Project();
    this.project.addSketch('Sketch 1');
    this.view = new View();
    this.canvas = document.getElementById('canvas');
    this.renderer = new Renderer(this.canvas, this.view);
    this.snap = new SnapEngine();
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
    this._setupTopbar();
    this._setupSidebar();
    this._setupModal();
    this._setupResize();
    this.refreshUI();
    this.solveAndRender();
    this._loop();
  }

  /* ---- Sketch helpers ---- */
  activeSketch() { return this.project.active(); }
  visibleSketches() { return this.project.visibleSketches(); }
  activeVisibleSketches() {
    const s = this.activeSketch();
    return (s && s.visible) ? [s] : [];
  }

  makeOrReusePoint(world, snap, sketch) {
    // Endpoint snaps return the snapped Point directly so callers share
    // an existing corner only inside the active sketch. Endpoints from
    // inactive sketches stay reference geometry, so we create a new active
    // point and constrain it to the reference instead of sharing the object.
    if (snap && snap.kind === 'endpoint' && snap.entity instanceof Point && !this.arcEndpointRef(snap.entity)) {
      const owner = this.project.sketchOf(snap.entity);
      if (owner && owner.id === sketch.id) return { point: snap.entity, reused: true };
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

  _isInvalidConstraint(sketch, c) {
    if (!sketch || !c) return false;
    if (c.kind !== 'coincident') return false;
    for (const e of sketch.entities) {
      if (e instanceof Line) {
        const samePair = (c.p1 === e.p1.id && c.p2 === e.p2.id) ||
          (c.p1 === e.p2.id && c.p2 === e.p1.id);
        if (samePair) return true;
      }
    }
    return false;
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
        for (const c of e.children()) if (c.hit(world, v)) return c;
        if (e instanceof Point && e.hit(world, v)) return e;
      }
    }
    for (const s of sketches) {
      for (const e of s.entities) if (!(e instanceof Point) && e.hit(world, v)) return e;
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
        for (const c of e.children()) if (c.hit(world, v)) add(c);
        if (e instanceof Point && e.hit(world, v)) add(e);
      }
    }
    for (const s of sketches) {
      for (const e of s.entities) {
        if (!(e instanceof Point) && e.hit(world, v)) add(e);
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

  _snapForDragging(world) {
    const drag = this.tool?.dragging;
    if (!drag) return null;
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    const draggedSet = new Set(drag.pts.map(r => r.p));
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
  collectDragSnaps(drag, primary) {
    if (!drag) return [];
    const out = [];
    const usedHandles = new Set();
    if (primary) {
      out.push(primary);
      if (primary.dragRecord) usedHandles.add(primary.dragRecord);
    }
    const draggedSet = new Set(drag.pts.map(r => r.p));
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
for (const Mixin of [DimensionLabelsMixin, SelectionMixin, DragMixin, SolveMixin, OperationsMixin, ConstraintActionsMixin, RenderEventsMixin, PanelsMixin, PersistenceMixin]) {
  for (const key of Object.getOwnPropertyNames(Mixin.prototype)) {
    if (key === 'constructor') continue;
    Object.defineProperty(App.prototype, key, Object.getOwnPropertyDescriptor(Mixin.prototype, key));
  }
}

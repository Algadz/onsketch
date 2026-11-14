import { constraintLabel } from '../core/constraints.js';
import { Arc, Circle, Line, Point, newId } from '../core/entities.js';
import { ArcEndpointArcEndpointCoincidentConstraint, ArcEndpointCoincidentConstraint, ArcEndpointFixConstraint, ArcEndpointMidpointConstraint, ArcEndpointOnCircleConstraint, ArcEndpointOnLineConstraint, CoincidentConstraint, FixConstraint, HorizontalConstraint, MidpointConstraint, PointOnCircleConstraint, PointOnLineConstraint, PointRefHorizontalConstraint, PointRefVerticalConstraint, VerticalConstraint } from '../core/constraints.js';
import { Solver } from '../core/solver.js';
import { Project } from '../core/model.js';
import { View } from '../render/view.js';
import { Renderer } from '../render/renderer.js';
import { SnapEngine } from '../editor/snap.js';
import { SelectTool } from '../tools/select.js';
import { armOnPress } from '../ui/tap-guard.js';
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
import { ReportMixin } from './report.js';
import { DimLinksMixin } from './dim-links.js';
import { InkSelectMixin } from './ink-select.js';
import { InkLinksMixin } from './ink-links.js';
import { TextEditMixin } from './text-edit.js';
import { InkTransformMixin } from './ink-transform.js';
import { TouchMixin } from './touch.js';
import { TouchUIMixin } from './touch-ui.js';
import { CompactMixin } from './compact.js';
import { CloudMixin } from './cloud-ui.js';
import { ImageImportMixin } from './image-import.js';
import { ClipboardMixin } from './clipboard.js';
import { PatternsMixin } from './patterns.js';
import { ExportMixin } from './export.js';
import { GuideMixin } from './guide.js';
import { InsertMixin } from './insert.js';
import { onImageLoad } from '../core/images.js';
import { trackOnce } from '../ui/analytics.js';

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
    this.pattern = null;           // pattern being created / edited (patterns.js)
    this.scissorsMode = 'trim';    // Scissors tool: 'trim' | 'split'
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
    this._setupReport();
    this._setupImageImport();
    this._setupClipboard();
    onImageLoad(() => this.requestRender());
    this._loadStylusPref();
    this._setupCompact();
    this._setupFab();
    this._setupResize();
    this._displayReady = true;                   // from here, projects carry their display
    this.project.display = this.displaySettings();
    const restored = this.loadLocalIfAny();
    this._setupAutosave();
    this._setupCloud();
    this.refreshUI();
    this.solveAndRender();
    if (restored) { this._primeFillRegions(); this.zoomFit(); }
    this._setupGuide(restored);
    this._loop();
  }

  /* ---- Project ---- */
  /** Every project swap (new, import, undo/redo) goes through here so
   *  new geometry keeps getting the current drawing style. */
  get project() { return this._project; }
  set project(p) {
    this._project = p;
    if (p) p.drawStyle = this.pen ? this._penStyle() : null;
    // A project opened from storage brings its display (grid, snap,
    // dimensions, relations); undo / redo keep the current one (toggling
    // isn't an undo step); a project without one takes the current setup.
    if (p && this._displayReady) {
      if (this._keepDisplay || !p.display) p.display = this.displaySettings();
      else this.applyDisplay(p.display);
    }
  }

  /* ---- Sketch helpers ---- */
  activeSketch() { return this.project.active(); }
  visibleSketches() { return this.project.visibleSketches(); }
  activeVisibleSketches() {
    const s = this.activeSketch();
    return (s && s.visible) ? [s] : [];
  }

  /* ---- Layers: display only ----
     Layers group shapes for display (visibility, opacity, order) and
     say where new shapes go (the active layer). They don't matter to
     relations, dimensions, the solver or editing: any visible shape can
     be picked, dragged, related, dimensioned and deleted. */
  /** Entity's layer is shown (hidden layers are still solved). */
  isEntityVisible(e) { const l = this.project.layerOf(e); return !l || l.visible; }
  /** Entity can be hovered, picked, box-selected, dragged: any visible shape. */
  isEntityInteractive(e) { return this.isEntityVisible(e); }
  isEntityPickable(e) { return this.isEntityVisible(e); }
  /** Visible and on the active layer: preferred when shapes overlap. */
  _onActiveLayer(e) {
    const l = this.project.layerOf(e);
    return !!l && l.visible && l.id === this.project.activeLayerId;
  }

  /** Layer a constraint belongs to (its own layerId, set when created). */
  constraintLayer(c) {
    return this.project.layer(c.layerId) || this.project.activeLayer();
  }
  /** Layers of the geometry a constraint ties (cached for one frame). */
  constraintGeometryLayers(c) {
    if (!this._refLayers) {
      const byId = new Map();
      for (const s of this.project.sketches) for (const e of s.entities) {
        const id = this.project.layerOf(e).id;
        byId.set(e.id, id);
        for (const ch of e.children()) if (!byId.has(ch.id)) byId.set(ch.id, id);
      }
      this._refLayers = { byId, memo: new Map() };
    }
    let out = this._refLayers.memo.get(c);
    if (!out) {
      out = new Set();
      for (const r of c.refs()) { const l = r && this._refLayers.byId.get(r); if (l) out.add(l); }
      this._refLayers.memo.set(c, out);
    }
    return out;
  }
  /** 'active' (shown, editable) or 'hidden': hidden when any of the
   *  shapes it ties is on a hidden layer (it still holds: hiding only
   *  hides). A relation or dimension without shapes follows its layer. */
  constraintLayerState(c) {
    const geo = this.constraintGeometryLayers(c);
    if (!geo.size) return this.constraintLayer(c).visible ? 'active' : 'hidden';
    return [...geo].some(id => this.project.layer(id)?.visible === false) ? 'hidden' : 'active';
  }

  makeOrReusePoint(world, snap, sketch) {
    // Endpoint snaps return the snapped Point directly so callers share
    // an existing corner only inside the active sketch. Endpoints from
    // inactive sketches stay reference geometry, so we create a new active
    // point and constrain it to the reference instead of sharing the object.
    // A corner on any layer is shared, as on one layer (layers are display
    // only).
    if (snap && snap.kind === 'endpoint' && snap.entity instanceof Point && !this.arcEndpointRef(snap.entity)) {
      const owner = this.project.ownerOf(snap.entity);
      if (owner && sketch.entities.includes(owner)) {
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
      trackOnce('relation-refused', { kind: c.kind, reason: conflict ? 'conflict' : 'implied' });
      if (!quiet && conflict) {
        const label = constraintLabel(c);
        document.getElementById('status-hint').textContent =
          `${label} not added: it conflicts with the existing constraints (the sketch would be over-defined).`;
      }
      return false;
    }
    return true;
  }


  /** Hit on any visible layer; the active layer's shapes win where
   *  shapes overlap (children win over their parents). */
  hitTestAcrossLayers(world) {
    return this.hitTestSketches(world, this.project.visibleSketches(), (e) => this._onActiveLayer(e))
      || this.hitTestSketches(world, this.project.visibleSketches());
  }
  hitTestActiveSketch(world) { return this.hitTestAcrossLayers(world); }
  hitTestPickable(world) { return this.hitTestAcrossLayers(world); }

  hitTestSketches(world, sketches, ok = (e) => this.isEntityInteractive(e)) {
    const v = this._hitView();
    // Prefer points first, then larger entities. Standalone Point
    // entities, such as centerline midpoints, must win over line bodies.
    for (const s of sketches) {
      for (const e of s.entities) {
        if (!ok(e)) continue;
        for (const c of e.children()) if (c.hit(world, v)) return c;
        if (e instanceof Point && e.hit(world, v)) return e;
      }
    }
    for (const s of sketches) {
      for (const e of s.entities) if (!(e instanceof Point) && ok(e) && e.hit(world, v)) return e;
    }
    return null;
  }

  /** Every shape under the cursor on visible layers, the active layer's
   *  first. */
  hitTestAllSketches(world, sketches) {
    const v = this._hitView();
    const out = [];
    const seen = new Set();
    const add = (e) => {
      if (!e || seen.has(e)) return;
      seen.add(e);
      out.push(e);
    };
    const pass = (ok) => {
      for (const s of sketches) {
        for (const e of s.entities) {
          if (!ok(e)) continue;
          for (const c of e.children()) if (c.hit(world, v)) add(c);
          if (e instanceof Point && e.hit(world, v)) add(e);
        }
      }
      for (const s of sketches) {
        for (const e of s.entities) {
          if (!(e instanceof Point) && ok(e) && e.hit(world, v)) add(e);
        }
      }
    };
    pass((e) => this._onActiveLayer(e));
    pass((e) => this.isEntityVisible(e));
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
    this.cancelLinkPick();
    const items = this.hitTestAllSketches(world, this.activeVisibleSketches());
    // Ink under the cursor (no geometry there): select it with its group,
    // as most apps do on right-click, and offer the ink actions.
    const ink = items.length ? null : this.hitStrokeAt(world);
    if (!items.length && !ink) return this._showPasteMenu(ev);
    if (ink && !ink.selected) { this.clearSelection(); this.selectInk(ink, true); this.refreshUI(); this.requestRender(); }

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

    if (ink) {
      const sel = this.selectedStrokes();
      const head = document.createElement('div');
      head.className = 'context-menu-head';
      const one = { text: 'Text', image: 'Image', arrow: 'Arrow' }[sel[0]?.kind] || 'Stroke';
      head.textContent = sel.length === 1 ? one
        : `${sel.length} ink items${sel.every(s => s.group && s.group === sel[0].group) ? ' (group)' : ''}`;
      menu.appendChild(head);
    }
    // Geometry: its own actions, plus "link the selected ink here".
    const actions = ink ? this.inkContextActions()
      : [...this.contextActions(items), ...this.linkHereActions(items[0])];
    if (actions.length) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      if (!ink) menu.appendChild(sep);
      for (const a of actions) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'context-menu-item action';
        row.dataset.action = a.id;
        row.innerHTML = `<span class="glyph">${a.glyph || (a.id === 'midpoint' ? '⌐' : a.id === 'delete' ? '✕' : '┄')}</span><span>${a.label}</span>${a.hint ? `<span class="meta">${a.hint}</span>` : ''}`;
        row.addEventListener('click', () => { this.hideContextMenu(); a.run(); });
        menu.appendChild(row);
      }
    }

    armOnPress(menu);          // a long press that opens it under the finger must not pick an item
    document.body.appendChild(menu);
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(ev.clientX, window.innerWidth - rect.width - margin);
    const top = Math.min(ev.clientY, window.innerHeight - rect.height - margin);
    menu.style.left = Math.max(margin, left) + 'px';
    menu.style.top = Math.max(margin, top) + 'px';
    this.contextMenuEl = menu;
    if (items.length) this._setHoverTarget(items[0]);

    this.contextMenuDocPointerDown = (e) => {
      if (this.contextMenuEl && !this.contextMenuEl.contains(e.target)) this.hideContextMenu();
    };
    setTimeout(() => document.addEventListener('pointerdown', this.contextMenuDocPointerDown), 0);
    return true;
  }

  /** Right-click / long press on empty canvas after copying ink here:
   *  a menu with Paste. */
  _showPasteMenu(ev) {
    if (!this._inkClip) return false;
    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.addEventListener('pointerdown', e => e.stopPropagation());
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'context-menu-item action';
    row.dataset.action = 'paste';
    row.innerHTML = `<span class="glyph">⎘</span><span>Paste</span><span class="meta">${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+'}V</span>`;
    row.addEventListener('click', () => { this.hideContextMenu(); this.pasteFromMenu(); });
    menu.appendChild(row);
    armOnPress(menu);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(ev.clientX, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(ev.clientY, window.innerHeight - rect.height - 8)) + 'px';
    this.contextMenuEl = menu;
    this.contextMenuDocPointerDown = (e) => { if (this.contextMenuEl && !this.contextMenuEl.contains(e.target)) this.hideContextMenu(); };
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

  /** Alt held (keyboard and mouse or pen: desktop) turns snapping off
   *  while placing or dragging: no snap to points, lines, the grid or the
   *  horizontal / vertical axes, and no relation added from a snap; the
   *  point goes exactly where the cursor is. */
  snapSuppressed() { return !!this._altNoSnap; }
  snapActive() { return this.snapOn && !this._altNoSnap; }

  /** Snap is only meaningful while you're actively placing or moving
   *  geometry. In plain Select mode (no drag in progress) and while using
   *  Smart Dim (which hit-tests entities, not snap points), we suppress
   *  snap detection so no markers or "endpoint / on-line / on-circle"
   *  hints flash at the cursor. */
  _snapForCurrentTool(world) {
    if (!this.snapActive()) return null;
    // Arrow ends snap like line ends (and attach to what they land on),
    // when drawing an arrow or dragging the end of a selected one.
    const drawing = ['line','centerLine','rectangle','centerRectangle','circle','threePointCircle','hexagon','arc','point','arrow'].includes(this.toolName)
      || (this.toolName === 'select' && this.tool && this.tool.arrowEnd);
    const dragging = this.toolName === 'select' && this.tool && this.tool.dragging;
    if (!drawing && !dragging) return null;
    if (dragging) return this._snapForDragging(world);
    return this.snap.find(world, this.view, this.visibleSketches());
  }

  /** Dragged points plus every line / arc / circle they belong to: a
   *  dragged point can't meaningfully snap onto its own geometry.
   *  Points tied to a dragged one by a coincident relation (two squares
   *  sharing a corner through a relation, not one point) are the same
   *  corner: they sit where the drag was a frame ago, so snapping to them
   *  held the point back until the cursor got a snap radius away, then it
   *  jumped (a staircase, worse with a finger's larger radius). They and
   *  their shapes are left out too. */
  _dragSnapExclusions(drag) {
    if (drag._snapExclusions) return drag._snapExclusions;
    const set = new Set(drag.pts.map(r => r.p));
    const sketch = this.activeSketch();
    if (sketch) {
      const byId = new Map();
      for (const e of sketch.entities) { byId.set(e.id, e); for (const c of e.children()) byId.set(c.id, c); }
      const ids = new Set([...set].map(p => p.id));
      const add = (p) => { if (p && !ids.has(p.id)) { ids.add(p.id); set.add(p); return true; } return false; };
      for (let grew = true; grew;) {
        grew = false;
        for (const c of sketch.constraints) {
          if (c.kind === 'coincident') {
            if (ids.has(c.p1)) grew = add(byId.get(c.p2)) || grew;
            if (ids.has(c.p2)) grew = add(byId.get(c.p1)) || grew;
          } else if (c.kind === 'arcEndpointCoincident' && c.ref) {
            const end = byId.get(c.ref.arcId)?.[c.ref.which];
            if (ids.has(c.pointId)) grew = add(end) || grew;
            if (end && ids.has(end.id)) grew = add(byId.get(c.pointId)) || grew;
          }
        }
      }
      for (const e of sketch.entities) if (e.children().some(c => set.has(c))) set.add(e);
    }
    drag._snapExclusions = set;
    return set;
  }

  /** Where every shape of the active sketch is when a drag starts. */
  _captureRestShapes() {
    const rest = new Map();
    const sketch = this.activeSketch(); if (!sketch) return rest;
    for (const e of sketch.entities) {
      for (const c of e.children()) rest.set(c, { x: c.x, y: c.y });
      if (e instanceof Point) rest.set(e, { x: e.x, y: e.y });
      if (Number.isFinite(e.r)) rest.set(e, { r: e.r });
    }
    return rest;
  }

  /** True when a snap candidate belongs to geometry that has moved since
   *  the drag started: it moves because of the drag (it follows the
   *  dragged point through relations), so it sits where the drag was a
   *  frame earlier. Snapping to it would pull the point back, then let it
   *  jump: a stutter, and on release a relation that collapses a shape. */
  _dragSnapTargetMoves(drag, candidate) {
    const rest = drag.restShapes, e = candidate.entity;
    if (!rest || !e) return false;
    const tol = 0.25 / this.view.zoom;
    const moved = (p) => { const r = rest.get(p); return !!r && Math.hypot(p.x - r.x, p.y - r.y) > tol; };
    if (e instanceof Point) return moved(e);
    if (e.children().some(moved)) return true;
    const r = rest.get(e);
    return !!(r && Number.isFinite(e.r) && Math.abs(e.r - r.r) > tol);
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
          this._dragSnapTargetMoves(drag, candidate) ||
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
    if (!drag || !this.snapActive()) return [];
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
          this._dragSnapTargetMoves(drag, candidate) ||
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
for (const Mixin of [ChromeMixin, EquationsMixin, LayersPanelMixin, FillsMixin, DimensionLabelsMixin, SelectionMixin, DragMixin, SolveMixin, OperationsMixin, ConstraintActionsMixin, RenderEventsMixin, PanelsMixin, PersistenceMixin, SketchWindowMixin, ReportMixin, DimLinksMixin, InkSelectMixin, InkLinksMixin, TextEditMixin, InkTransformMixin, TouchMixin, TouchUIMixin, CompactMixin, CloudMixin, ImageImportMixin, ClipboardMixin, PatternsMixin, ExportMixin, GuideMixin, InsertMixin]) {
  for (const key of Object.getOwnPropertyNames(Mixin.prototype)) {
    if (key === 'constructor') continue;
    Object.defineProperty(App.prototype, key, Object.getOwnPropertyDescriptor(Mixin.prototype, key));
  }
}

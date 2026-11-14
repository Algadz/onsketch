import { toolDef } from '../ui/tool-defs.js';
import { fillCursor } from '../ui/cursors.js';
import { Arc, Bezier, Circle, Line, Point } from '../core/entities.js';
import { bezierBBox, bezierSamples } from '../core/bezier.js';
import { SelectTool } from '../tools/select.js';
import { ArcTool, CenterLineTool, CenterRectangleTool, CircleTool, HexagonTool, LineTool, PointTool, RectangleTool, ThreePointCircleTool } from '../tools/draw.js';
import { FillTool } from '../tools/fill.js';
import { ScissorsTool } from '../tools/scissors.js';
import { BezierTool } from '../tools/bezier.js';
import { EraserTool, InkTool } from '../tools/freehand.js';
import { TextTool } from '../tools/text.js';
import { ArrowTool } from '../tools/arrow.js';
import { SmartDimensionTool } from '../tools/smartdim.js';
import { trackOnce } from '../ui/analytics.js';

export class RenderEventsMixin {

  /* ---- Render loop ---- */
  requestRender() { this.dirty = true; }
  _loop() {
    const tick = () => { if (this.dirty) { this._render(); this.dirty = false; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  _render() {
    this.refreshDrivenDimensions();           // floating dimensions show what they measure
    this.syncInkLinks();                      // linked ink follows its geometry
    this.renderer.drawGrid(this.gridOn, this.project.background);
    this.renderer.drawEntities(this.project, this.fillDisplay());
    this._drawInkLinks();
    this._drawInkTransform(this.tool?.inkTransform);
    if (this._textEdit) this._textEdit.place();

    // Build a project-wide id → entity lookup for dimension drawing.
    const entMap = new Map();
    const walk = (e) => { entMap.set(e.id, e); for (const c of e.children()) walk(c); };
    for (const s of this.project.visibleSketches()) for (const e of s.entities) walk(e);
    this._refLayers = null;                   // constraint → layers, rebuilt for this frame
    const sketch = this.activeSketch();
    if (sketch && this.showDimensions) {
      this.renderer.drawDimensions(sketch, entMap, this._lastSolve?.redundantIds, (c) => this.constraintLayerState(c));
    }
    if (sketch && this.showRelations) {
      this.renderer.drawRelations(sketch, entMap, this._lastSolve?.redundantIds, (c) => this.constraintLayerState(c));
    } else this.renderer.lastRelRects = [];

    const prev = this.tool.getPreview && this.tool.getPreview();
    if (prev) {
      if (prev.paths)      for (const p of prev.paths) this.renderer.drawTempPath(p, prev.dashed);
      if (prev.dashedPaths) for (const p of prev.dashedPaths) this.renderer.drawTempPath(p, true);
      if (prev.circles)    for (const c of prev.circles) this.renderer.drawTempCircle(c.center, c.r);
      if (prev.arcs)       for (const a of prev.arcs) this.renderer.drawTempArc(a.center, a.r, a.a0, a.a1, !!a.clockwise);
      if (prev.curves)     for (const c of prev.curves) this.renderer.drawTempPath(bezierSamples(c, 48), prev.dashed);
      if (prev.handles)    this.renderer.drawTempHandles(prev.handles);
      if (prev.points)     for (const p of prev.points) this.renderer.drawTempPoint(p);
      if (prev.box)        this.renderer.drawSelectionBox(prev.box);
      if (prev.dimPicks)   this.renderer.drawDimPicks(prev.dimPicks);
      if (prev.dimPreview) this.renderer.drawDimPreview(prev.dimPreview);
      if (prev.strokes)    for (const st of prev.strokes) this.renderer.drawStroke(st);
      if (prev.brush)      this.renderer.drawBrush(prev.brush);
      if (prev.cut)        this.renderer.drawCutPreview(prev.cut);
    }
    // Touch has no hover: mark the placed first point of a two-point tool.
    if (this.touchUI && this._twoPointAnchor) this.renderer.drawTempPoint(this._twoPointAnchor());
    const opPrev = (this.getMirrorPreview && this.getMirrorPreview())
      || (this.getOffsetPreview && this.getOffsetPreview())
      || (this.getPatternPreview && this.getPatternPreview());
    if (opPrev) {
      if (opPrev.paths)   for (const p of opPrev.paths) this.renderer.drawTempPath(p, true);
      if (opPrev.circles) for (const c of opPrev.circles) this.renderer.drawTempCircle(c.center, c.r);
      if (opPrev.arcs)    for (const a of opPrev.arcs) this.renderer.drawTempArc(a.center, a.r, a.a0, a.a1, !!a.clockwise);
      if (opPrev.curves)  for (const c of opPrev.curves) this.renderer.drawTempPath(bezierSamples(c, 48), true);
      if (opPrev.points)  for (const p of opPrev.points) this.renderer.drawTempPoint(p);
      if (opPrev.marks)   this.renderer.drawPatternMarks(opPrev.marks);
    }

    if (this._drawLoupe) queueMicrotask(() => this._drawLoupe());
    if (this.snapActive()) {
      // During a drag, lastDragSnaps holds every active snap (primary +
      // any secondary handles that incidentally landed on snap targets).
      // Otherwise, we just have the single cursor snap to draw.
      if (this.lastDragSnaps && this.lastDragSnaps.length) {
        for (const s of this.lastDragSnaps) this.renderer.drawSnapMarker(s);
      } else {
        this.renderer.drawSnapMarker(this.lastSnap);
      }
    }
  }

  /** Canvas cursor for the active tool. The Fill tool shows a paint drop
   *  in the current fill colour (with × in erase mode). */
  _updateCanvasCursor() {
    const name = this.toolName;
    this.canvas.style.cursor = name === 'select' ? 'default'
      : name === 'fill' ? fillCursor(this.pen?.fillColor, this.fillErase)
      : name === 'text' ? 'text'
      : 'crosshair';
  }

  /** Scissors: 'trim' (remove a piece) or 'split' (cut in two). */
  setScissorsMode(mode) {
    this.scissorsMode = mode === 'split' ? 'split' : 'trim';
    if (this.tool?.pending) this.tool.pending = null;
    if (this.tool) this.tool.hover = null;
    this._refreshOptionsBar();
    const el = document.getElementById('status-hint');
    if (el && this.tool?.hint) el.textContent = this.tool.hint();
    this.requestRender();
  }

  /* ---- Tool selection ---- */
  setTool(name) {
    if (name !== this.toolName) trackOnce('tool', { name });
    this.hideContextMenu();
    this._clearOperationState();
    this.finishTextEdit();
    this.linkPick = null;
    this._inkDragItems = null;
    if (this.tool && this.tool.deactivate) this.tool.deactivate();
    this.toolName = name;
    switch (name) {
      case 'select':    this.tool = new SelectTool(this); break;
      case 'line':      this.tool = new LineTool(this); break;
      case 'centerLine': this.tool = new CenterLineTool(this); break;
      case 'rectangle': this.tool = new RectangleTool(this); break;
      case 'centerRectangle': this.tool = new CenterRectangleTool(this); break;
      case 'circle':    this.tool = new CircleTool(this); break;
      case 'threePointCircle': this.tool = new ThreePointCircleTool(this); break;
      case 'hexagon':   this.tool = new HexagonTool(this); break;
      case 'arc':       this.tool = new ArcTool(this); break;
      case 'point':     this.tool = new PointTool(this); break;
      case 'smartdim':  this.tool = new SmartDimensionTool(this); break;
      case 'fill':      this.tool = new FillTool(this); break;
      case 'trim':      this.tool = new ScissorsTool(this); break;
      case 'curve':     this.tool = new BezierTool(this); break;
      case 'pen':       this.tool = new InkTool(this, 'pen'); break;
      case 'marker':    this.tool = new InkTool(this, 'marker'); break;
      case 'eraser':    this.tool = new EraserTool(this); break;
      case 'text':      this.tool = new TextTool(this); break;
      case 'arrow':     this.tool = new ArrowTool(this); break;
    }
    if (this.tool.activate) this.tool.activate();
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
    document.getElementById('status-tool').textContent = 'Tool: ' + toolDef(name).label;
    if (name === 'smartdim' && !this.showDimensions) this.setDimensionsVisible(true);
    if (this._refreshSketchWindow) this._refreshSketchWindow();
    if (this._syncColorTarget) this._syncColorTarget();
    if (this.compact) this._renderMobileBar();
    if (this._guide) this._guideRender(this._guideState());   // the first-run card follows the tool
    this._refreshOptionsBar();
    document.getElementById('status-hint').textContent = (this.tool.hint && this.tool.hint()) || '';
    this._updateCanvasCursor();
    this.refreshToolOptions();
    this.requestRender();
  }

  /* ---- Canvas events ---- */
  _setupCanvasEvents() {
    const c = this.canvas;
    let panning = false; let panStart = null;

    const getWorld = (ev) => {
      const r = c.getBoundingClientRect();
      const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      return { screen: {x:sx, y:sy}, world: this.view.screenToWorld({x:sx, y:sy}) };
    };

    c.addEventListener('contextmenu', e => e.preventDefault());

    c.addEventListener('dblclick', (ev) => {
      if (this.toolName === 'line' && this.tool && this.tool.startPt) {
        ev.preventDefault();
        this.tool.terminateChain(true);
        return;
      }
      // Double-click a text (not under geometry) to edit it.
      if (this.toolName === 'select' && !this.linkPick) {
        const { world } = getWorld(ev);
        const t = !this.hitTestActiveSketch(world) && this.hitStrokeAt(world, { textOnly: true });
        if (t) { ev.preventDefault(); this.editText(t); }
      }
    });

    // Mouse events go straight to these handlers. Touch and pen events pass
    // through the touch layer first (touch.js): it handles pan / pinch,
    // long press and taps, and replays the rest into the same handlers.
    const down = (ev) => {
      const { screen, world } = getWorld(ev);
      if (ev.button === 2) {
        ev.preventDefault();
        this.showContextMenu(screen, world, ev);
        return;
      }
      this.hideContextMenu();
      this._noteAlt(ev);
      // A dimension value box is open: clicking a shape inserts its name.
      if (ev.button === 0 && !this._spaceHeld && this._valueInput && this._valueInputPick(world)) {
        ev.preventDefault();
        return;
      }
      c.setPointerCapture(ev.pointerId);
      // Pan: middle button, or Space + drag (Alt is "no snap").
      if (ev.button === 1 || (ev.button === 0 && this._spaceHeld)) {
        panning = true;
        panStart = { x: ev.clientX, y: ev.clientY, panX: this.view.panX, panY: this.view.panY };
        c.style.cursor = 'grabbing';
        return;
      }
      const snap = this._snapForCurrentTool(world);
      this.lastSnap = snap;
      if (ev.pointerType && ev.pointerType !== 'mouse' && this._twoPointDown(world, snap, screen, ev)) return;
      this.tool.onPointerDown(world, snap, ev);
    };

    const move = (ev) => {
      const { screen, world } = getWorld(ev);
      this.lastWorldCursor = world;
      this._noteAlt(ev);
      if (ev.pointerType !== 'touch') { this._lastMouseMove = ev; this._pointerOnCanvas = true; }
      document.getElementById('status-coords').textContent = `x: ${world.x.toFixed(3)}  y: ${world.y.toFixed(3)}`;
      if (panning) {
        this.view.panX = panStart.panX + (ev.clientX - panStart.x);
        this.view.panY = panStart.panY + (ev.clientY - panStart.y);
        this.requestRender();
        return;
      }
      if (this.contextMenuEl) {
        this.lastSnap = null;
        document.getElementById('cursor-hint').style.display = 'none';
        return;
      }
      const snap = this._snapForCurrentTool(world);
      this.lastSnap = snap;
      this.tool.onPointerMove(world, snap, ev);
      const hint = document.getElementById('cursor-hint');
      if (this.snapOn && this.snapSuppressed() && this._placingOrDragging()) {
        // Alt: say so at the cursor, where snap names usually appear.
        hint.textContent = 'no snap';
        hint.style.left = screen.x + 'px';
        hint.style.top = screen.y + 'px';
        hint.style.display = 'block';
      } else if (snap && !snap.rejected) {
        hint.textContent = snap.kind;
        hint.style.left = screen.x + 'px';
        // Above the finger on touch, so the finger doesn't hide it.
        hint.style.top  = (ev.pointerType === 'touch' ? screen.y - 44 : screen.y) + 'px';
        hint.style.display = 'block';
      } else hint.style.display = 'none';
      if (this._loupeFollow) this._loupeFollow(ev, screen);
      this.requestRender();
    };

    const up = (ev) => {
      if (ev.button === 2) return;
      const { screen, world } = getWorld(ev);
      if (panning) { panning = false; this._updateCanvasCursor(); return; }
      this._noteAlt(ev);
      const snap = this._snapForCurrentTool(world);
      if (ev.pointerType && ev.pointerType !== 'mouse' && this._twoPointUp(world, snap, screen, ev)) return;
      this.tool.onPointerUp(world, snap, ev);
    };

    this._canvasHandlers = { down, move, up, getWorld };
    const routed = (kind, fn) => (ev) => {
      this._noteInput(ev);
      if (ev.pointerType && ev.pointerType !== 'mouse' && this._touchFilter(kind, ev)) return;
      fn(ev);
    };
    c.addEventListener('pointerdown', routed('down', down));
    c.addEventListener('pointermove', routed('move', move));
    c.addEventListener('pointerup', routed('up', up));
    c.addEventListener('pointercancel', (ev) => {   // touch / pen only: the browser took the pointer
      if (ev.pointerType && ev.pointerType !== 'mouse') this._touchFilter('cancel', ev);
    });

    // The brush footprint of the Sketch tools leaves with the pointer.
    c.addEventListener('pointerleave', () => {
      if (this.tool && 'cursor' in this.tool && (this.tool instanceof InkTool || this.tool instanceof EraserTool)) {
        this.tool.cursor = null;
        this.requestRender();
      }
    });

    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.hideContextMenu();
      const r = c.getBoundingClientRect();
      const sp = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const factor = Math.exp(-ev.deltaY * 0.0015);
      this.view.zoomAt(sp, factor);
      document.getElementById('status-zoom').textContent = 'Zoom: ' + Math.round(this.view.zoom*25) + '%';
      this.requestRender();
    }, { passive: false });
  }

  /** Alt state from a mouse or pen event (touch has no keyboard). */
  _noteAlt(ev) {
    if (!ev || ev.pointerType === 'touch') return;
    this._setAltNoSnap(!!ev.altKey);
  }

  _setAltNoSnap(on) {
    if (!!this._altNoSnap === on) return;
    this._altNoSnap = on;
    document.querySelector('#menubar [data-action="snap"]')?.classList.toggle('held-off', on && this.snapOn);
    if (on) { this.lastSnap = null; this.lastDragSnaps = []; }
  }

  /** A drawing tool is placing, or something is being dragged: the moments
   *  snapping matters. */
  _placingOrDragging() {
    const t = this.tool;
    return ['line', 'centerLine', 'rectangle', 'centerRectangle', 'circle', 'threePointCircle', 'hexagon', 'arc', 'point', 'curve', 'arrow'].includes(this.toolName)
      || !!(t && (t.dragging || t.arrowEnd));
  }

  /** Alt pressed or released without moving: replay the last mouse move
   *  so the preview, the snap marker and the drag follow at once. */
  _replayMove(alt) {
    const ev = this._lastMouseMove;
    if (!ev || !this._canvasHandlers || !this._pointerOnCanvas && !this.tool?.dragging) return;
    this._canvasHandlers.move({
      clientX: ev.clientX, clientY: ev.clientY, pointerType: ev.pointerType, pointerId: ev.pointerId,
      button: ev.button, buttons: ev.buttons, shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: alt,
    });
  }

  _setupKeyboard() {
    // Alt: no snap while placing or dragging. Space held: drag pans.
    const altKey = (ev) => {
      if (ev.key !== 'Alt') return;
      const on = ev.type === 'keydown';
      // Keep the browser's menu from taking Alt over the canvas.
      if (this._pointerOnCanvas || this.tool?.dragging) ev.preventDefault();
      if (!!this._altNoSnap === on) return;
      this._setAltNoSnap(on);
      this._replayMove(on);
      this.requestRender();
    };
    window.addEventListener('keydown', altKey);
    window.addEventListener('keyup', altKey);
    window.addEventListener('blur', () => { this._setAltNoSnap(false); this._spaceHeld = false; this._updateCanvasCursor(); });
    window.addEventListener('keydown', (ev) => {
      if (ev.code !== 'Space' || ev.target.matches('input,textarea,select,button,[contenteditable="true"]')) return;
      if (!this._pointerOnCanvas) return;
      ev.preventDefault();                        // no page scroll
      if (!this._spaceHeld) { this._spaceHeld = true; this.canvas.style.cursor = 'grab'; }
    });
    window.addEventListener('keyup', (ev) => {
      if (ev.code !== 'Space' || !this._spaceHeld) return;
      this._spaceHeld = false;
      this._updateCanvasCursor();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.target.matches('input,textarea,[contenteditable="true"]')) return;
      if (ev.key === 'Escape' && this.contextMenuEl) {
        ev.preventDefault();
        this.hideContextMenu();
        return;
      }
      if (ev.key === 'Escape' && this.linkPick) {
        ev.preventDefault();
        this.cancelLinkPick();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'g') {
        ev.preventDefault();
        if (ev.shiftKey) this.ungroupSelectedInk(); else this.groupSelectedInk();
        return;
      }
      if (ev.key === 'Escape' && this.operationName && this.cancelOperation()) {
        ev.preventDefault();
        return;
      }
      // Enter creates the pattern (or finishes editing it).
      if (ev.key === 'Enter' && this.operationName === 'pattern' && this.pattern && !ev.target.matches('button')) {
        ev.preventDefault();
        if (this.pattern.mode === 'edit') this.finishPatternEdit(); else this.createPattern();
        return;
      }
      const k = ev.key.toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && k === 's') { ev.preventDefault(); this.save(); return; }
      if ((ev.ctrlKey || ev.metaKey) && k === 'o' && this.cloudEnabled) { ev.preventDefault(); this.openSketch(); return; }
      if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); this.undo(); return; }
      if ((ev.ctrlKey || ev.metaKey) && (k === 'y' || (ev.shiftKey && k === 'z'))) { ev.preventDefault(); this.redo(); return; }
      // Ctrl / ⌘ with a letter is a command (copy, paste…), never a tool.
      if (ev.ctrlKey || ev.metaKey) { this.tool.onKey && this.tool.onKey(ev); return; }
      if (k === 's') this.setTool('select');
      else if (k === 'l') this.setTool(ev.shiftKey ? 'centerLine' : 'line');
      else if (k === 'r') this.setTool(ev.shiftKey ? 'centerRectangle' : 'rectangle');
      else if (k === 'c') this.setTool(ev.shiftKey ? 'threePointCircle' : 'circle');
      else if (k === 'h') this.setTool('hexagon');
      else if (k === 'a') this.setTool('arc');
      else if (k === 'p') this.setTool('point');
      else if (k === 'v') this.setTool('curve');
      else if (k === 'x') { if (this.toolName === 'trim') this.setScissorsMode(this.scissorsMode === 'split' ? 'trim' : 'split'); else this.setTool('trim'); }
      else if (k === 'd') this.setTool('smartdim');
      else if (k === 'b') this.setTool('fill');
      else if (k === 'n') this.setTool('pen');
      else if (k === 'g') this.setTool('marker');
      else if (k === 'e') this.setTool('eraser');
      else if (k === 't') this.setTool('text');
      else if (k === 'w') this.setTool('arrow');
      else if (k === 'i' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) this.openImagePicker();
      else if (k === 'm') this.setDimensionsVisible(!this.showDimensions);
      else if (k === 'k') this.setRelationsVisible(!this.showRelations);
      else if (k === 'f') this.zoomFit();
      else if (k === 'f5') { ev.preventDefault(); this.solveAndRender(); }
      this.tool.onKey && this.tool.onKey(ev);
    });
  }

  /* ---- Top bar ---- */
  zoomFit() {
    const sketch = this.activeSketch(); if (!sketch || sketch.entities.length === 0) return;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    const acc = (p) => { if (p.x<minX) minX=p.x; if (p.y<minY) minY=p.y; if (p.x>maxX) maxX=p.x; if (p.y>maxY) maxY=p.y; };
    for (const e of sketch.entities) {
      if (e instanceof Line) { acc(e.p1); acc(e.p2); }
      else if (e instanceof Circle) { acc({x:e.center.x-e.r, y:e.center.y-e.r}); acc({x:e.center.x+e.r, y:e.center.y+e.r}); }
      else if (e instanceof Arc)    { acc({x:e.center.x-e.r, y:e.center.y-e.r}); acc({x:e.center.x+e.r, y:e.center.y+e.r}); }
      else if (e instanceof Bezier) { const b = bezierBBox(e.ctrl()); acc({ x: b.minX, y: b.minY }); acc({ x: b.maxX, y: b.maxY }); }
      else if (e instanceof Point)  { acc(e); }
    }
    if (minX === Infinity) return;
    this.view.fitTo({minX, minY, maxX, maxY}, 80);
    this.requestRender();
  }
}

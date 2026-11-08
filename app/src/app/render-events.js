import { toolDef } from '../ui/tool-defs.js';
import { fillCursor } from '../ui/cursors.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { SelectTool } from '../tools/select.js';
import { ArcTool, CenterLineTool, CenterRectangleTool, CircleTool, HexagonTool, LineTool, PointTool, RectangleTool, ThreePointCircleTool } from '../tools/draw.js';
import { FillTool } from '../tools/fill.js';
import { EraserTool, InkTool } from '../tools/freehand.js';
import { SmartDimensionTool } from '../tools/smartdim.js';

export class RenderEventsMixin {

  /* ---- Render loop ---- */
  requestRender() { this.dirty = true; }
  _loop() {
    const tick = () => { if (this.dirty) { this._render(); this.dirty = false; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  _render() {
    this.renderer.drawGrid(this.gridOn, this.project.background);
    this.renderer.drawEntities(this.project, this.fillDisplay());

    // Build a project-wide id → entity lookup for dimension drawing.
    const entMap = new Map();
    const walk = (e) => { entMap.set(e.id, e); for (const c of e.children()) walk(c); };
    for (const s of this.project.visibleSketches()) for (const e of s.entities) walk(e);
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
      if (prev.points)     for (const p of prev.points) this.renderer.drawTempPoint(p);
      if (prev.box)        this.renderer.drawSelectionBox(prev.box);
      if (prev.dimPicks)   this.renderer.drawDimPicks(prev.dimPicks);
      if (prev.dimPreview) this.renderer.drawDimPreview(prev.dimPreview);
      if (prev.strokes)    for (const st of prev.strokes) this.renderer.drawStroke(st);
      if (prev.brush)      this.renderer.drawBrush(prev.brush);
    }
    const opPrev = (this.getMirrorPreview && this.getMirrorPreview())
      || (this.getOffsetPreview && this.getOffsetPreview());
    if (opPrev) {
      if (opPrev.paths)   for (const p of opPrev.paths) this.renderer.drawTempPath(p, true);
      if (opPrev.circles) for (const c of opPrev.circles) this.renderer.drawTempCircle(c.center, c.r);
      if (opPrev.arcs)    for (const a of opPrev.arcs) this.renderer.drawTempArc(a.center, a.r, a.a0, a.a1, !!a.clockwise);
      if (opPrev.points)  for (const p of opPrev.points) this.renderer.drawTempPoint(p);
    }

    if (this.snapOn) {
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
      : 'crosshair';
  }

  /* ---- Tool selection ---- */
  setTool(name) {
    this.hideContextMenu();
    this._clearOperationState();
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
      case 'pen':       this.tool = new InkTool(this, 'pen'); break;
      case 'marker':    this.tool = new InkTool(this, 'marker'); break;
      case 'eraser':    this.tool = new EraserTool(this); break;
    }
    if (this.tool.activate) this.tool.activate();
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
    document.getElementById('status-tool').textContent = 'Tool: ' + toolDef(name).label;
    if (name === 'smartdim' && !this.showDimensions) this.setDimensionsVisible(true);
    if (this._refreshSketchWindow) this._refreshSketchWindow();
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
      }
    });

    c.addEventListener('pointerdown', (ev) => {
      const { screen, world } = getWorld(ev);
      if (ev.button === 2) {
        ev.preventDefault();
        this.showContextMenu(screen, world, ev);
        return;
      }
      this.hideContextMenu();
      c.setPointerCapture(ev.pointerId);
      if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
        panning = true;
        panStart = { x: ev.clientX, y: ev.clientY, panX: this.view.panX, panY: this.view.panY };
        c.style.cursor = 'grabbing';
        return;
      }
      const snap = this._snapForCurrentTool(world);
      this.lastSnap = snap;
      this.tool.onPointerDown(world, snap, ev);
    });

    c.addEventListener('pointermove', (ev) => {
      const { screen, world } = getWorld(ev);
      this.lastWorldCursor = world;
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
      if (snap && !snap.rejected) {
        hint.textContent = snap.kind;
        hint.style.left = screen.x + 'px';
        hint.style.top  = screen.y + 'px';
        hint.style.display = 'block';
      } else hint.style.display = 'none';
      this.requestRender();
    });

    c.addEventListener('pointerup', (ev) => {
      if (ev.button === 2) return;
      const { world } = getWorld(ev);
      if (panning) { panning = false; this._updateCanvasCursor(); return; }
      const snap = this._snapForCurrentTool(world);
      this.tool.onPointerUp(world, snap, ev);
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

  _setupKeyboard() {
    window.addEventListener('keydown', (ev) => {
      if (ev.target.matches('input,textarea,[contenteditable="true"]')) return;
      if (ev.key === 'Escape' && this.contextMenuEl) {
        ev.preventDefault();
        this.hideContextMenu();
        return;
      }
      if (ev.key === 'Escape' && this.operationName && this.cancelOperation()) {
        ev.preventDefault();
        return;
      }
      const k = ev.key.toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); this.undo(); return; }
      if ((ev.ctrlKey || ev.metaKey) && (k === 'y' || (ev.shiftKey && k === 'z'))) { ev.preventDefault(); this.redo(); return; }
      if (k === 's') this.setTool('select');
      else if (k === 'l') this.setTool(ev.shiftKey ? 'centerLine' : 'line');
      else if (k === 'r') this.setTool(ev.shiftKey ? 'centerRectangle' : 'rectangle');
      else if (k === 'c') this.setTool(ev.shiftKey ? 'threePointCircle' : 'circle');
      else if (k === 'h') this.setTool('hexagon');
      else if (k === 'a') this.setTool('arc');
      else if (k === 'p') this.setTool('point');
      else if (k === 'd') this.setTool('smartdim');
      else if (k === 'b') this.setTool('fill');
      else if (k === 'n') this.setTool('pen');
      else if (k === 'g') this.setTool('marker');
      else if (k === 'e') this.setTool('eraser');
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
      else if (e instanceof Point)  { acc(e); }
    }
    if (minX === Infinity) return;
    this.view.fitTo({minX, minY, maxX, maxY}, 80);
    this.requestRender();
  }
}

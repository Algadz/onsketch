import { EPS, TAU, centerRectangleCorners, circleFrom3Points, dist, normAngle, regularPolygonFromCenterEdge, signedAngleDelta } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { DirectedAngleConstraint, EqualLengthConstraint, HorizontalConstraint, MidpointConstraint, PointOnCircleConstraint, VerticalConstraint } from '../core/constraints.js';
import { Tool } from './tool.js';

export class LineTool extends Tool {
  constructor(app) {
    super(app);
    this.startPt = null;
    this.cursor = null;
    this.axisIntent = null;
    this.invalidEnd = false;
    this._lastPlaced = null;
  }
  hint() { return 'Click to place start, click again for end. Esc to finish.'; }
  activate() { this.startPt = null; this.axisIntent = null; this.invalidEnd = false; this._lastPlaced = null; }
  _axisSnapFor(target, snap) {
    if (!this.startPt || snap) return { point: target, kind: null };
    const dx = (target.x - this.startPt.x) * this.app.view.zoom;
    const dy = (target.y - this.startPt.y) * this.app.view.zoom;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (Math.max(adx, ady) < 16 || Math.min(adx, ady) > 8) return { point: target, kind: null };
    if (ady <= adx) return { point: { x: target.x, y: this.startPt.y }, kind: 'horizontal' };
    return { point: { x: this.startPt.x, y: target.y }, kind: 'vertical' };
  }
  _invalidEndFor(point, sketch) {
    if (!this.startPt || !point) return false;
    const minLen = 4 / this.app.view.zoom;
    if (dist(this.startPt, point) <= minLen) return true;
    return this.app.pointsCoincidentInSketch(sketch, this.startPt, point);
  }
  _setInvalidEnd(invalid) {
    this.invalidEnd = invalid;
    document.getElementById('status-hint').textContent = invalid
      ? 'Select a different end point.'
      : this.hint();
  }
  terminateChain(removeLastPlaced = false) {
    const sketch = this.app.activeSketch();
    if (removeLastPlaced && sketch && this._lastPlaced && sketch.entities.includes(this._lastPlaced.line)) {
      sketch.removeEntity(this._lastPlaced.line);
      if (this.app.undoStack.length === this._lastPlaced.undoLength) this.app.undoStack.pop();
      this.app.solveAndRender();
    }
    this.startPt = null;
    this._pendingStartSnap = null;
    this.axisIntent = null;
    this.cursor = null;
    this._lastPlaced = null;
    this._setInvalidEnd(false);
    this.app.requestRender();
  }
  onPointerDown(world, snap, ev) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    if (this.startPt && ev && ev.detail >= 2) {
      this.terminateChain(true);
      return;
    }
    const raw = snap ? { x: snap.x, y: snap.y } : world;
    if (!this.startPt) {
      const { point, reused } = this.app.makeOrReusePoint(raw, snap, sketch);
      this.startPt = point;
      this._pendingStartSnap = reused ? null : snap;
      this._lastPlaced = null;
    } else {
      const axis = this._axisSnapFor(raw, snap);
      const { point: endPt, reused: endReused } = this.app.makeOrReusePoint(axis.point, snap, sketch);
      if (this._invalidEndFor(endPt, sketch)) {
        this.cursor = axis.point;
        this._setInvalidEnd(true);
        this.app.requestRender();
        return;
      }
      const endSnap = endReused ? null : snap;
      const line = new Line(this.startPt, endPt);
      if (this.app.constructionMode) line.construction = true;
      sketch.addEntity(line);
      // Apply pending snap constraints after the line (and its endpoints)
      // are part of the sketch — otherwise the solver lookup won't find them.
      if (this._pendingStartSnap) {
        const cs = this.app.snapToConstraint(this._pendingStartSnap, this.startPt);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      if (endSnap) {
        const cs = this.app.snapToConstraint(endSnap, endPt);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      if (axis.kind === 'horizontal') {
        sketch.constraints.push(new HorizontalConstraint(line.id, line.p1.id, line.p2.id));
      } else if (axis.kind === 'vertical') {
        sketch.constraints.push(new VerticalConstraint(line.id, line.p1.id, line.p2.id));
      }
      this.app.commit();
      this._lastPlaced = { line, undoLength:this.app.undoStack.length };
      // Chain — the end point is now in the sketch, so no pending constraint.
      this.startPt = endPt;
      this._pendingStartSnap = null;
      this.axisIntent = null;
      this._setInvalidEnd(false);
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) {
    const raw = snap ? { x:snap.x, y:snap.y } : world;
    const axis = this._axisSnapFor(raw, snap);
    this.cursor = axis.point;
    this.axisIntent = axis.kind;
    if (this.startPt) {
      const candidate = snap ? (snap.entity instanceof Point ? snap.entity : axis.point) : axis.point;
      this._setInvalidEnd(this._invalidEndFor(candidate, this.app.activeSketch()));
    }
    this.app.requestRender();
  }
  onKey(ev) {
    // First Esc closes the current line chain. Second Esc exits to Select.
    if (ev.key === 'Escape' || ev.key === 'Enter') {
      if (this.startPt) { this.terminateChain(false); }
      else { this.app.setTool('select'); }
    }
  }
  getPreview() {
    if (!this.startPt || !this.cursor || this.invalidEnd) return null;
    return { paths: [[this.startPt, this.cursor]], dashed: this.app.constructionMode };
  }
}

export class CenterLineTool extends Tool {
  constructor(app) {
    super(app);
    this.center = null;
    this.cursor = null;
    this._centerSnap = null;
    this._centerReused = false;
    this.axisIntent = null;
  }
  hint() { return 'Click midpoint, then one endpoint.'; }
  activate() {
    this.center = null;
    this.cursor = null;
    this._centerSnap = null;
    this._centerReused = false;
    this.axisIntent = null;
  }
  _axisSnapFor(target, snap) {
    if (!this.center || snap) return { point: target, kind: null };
    const dx = (target.x - this.center.x) * this.app.view.zoom;
    const dy = (target.y - this.center.y) * this.app.view.zoom;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (Math.max(adx, ady) < 16 || Math.min(adx, ady) > 8) return { point: target, kind: null };
    if (ady <= adx) return { point: { x: target.x, y: this.center.y }, kind: 'horizontal' };
    return { point: { x: this.center.x, y: target.y }, kind: 'vertical' };
  }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const raw = snap ? { x:snap.x, y:snap.y } : world;
    if (!this.center) {
      const info = this.app.makeOrReusePoint(raw, snap, sketch);
      this.center = info.point;
      this._centerSnap = info.reused ? null : snap;
      this._centerReused = info.reused;
    } else {
      const axis = this._axisSnapFor(raw, snap);
      const w = axis.point;
      const dx = w.x - this.center.x;
      const dy = w.y - this.center.y;
      if (Math.hypot(dx, dy) < EPS) return;
      const endInfo = this.app.makeOrReusePoint(w, snap, sketch);
      const a = new Point(this.center.x - dx, this.center.y - dy);
      const b = endInfo.point;
      const line = new Line(a, b);
      if (this.app.constructionMode) line.construction = true;
      sketch.addEntity(line);
      if (!this._centerReused) sketch.addEntity(this.center);
      sketch.constraints.push(new MidpointConstraint(this.center.id, { a: line.p1.id, b: line.p2.id }));
      if (axis.kind === 'horizontal') {
        sketch.constraints.push(new HorizontalConstraint(line.id, line.p1.id, line.p2.id));
      } else if (axis.kind === 'vertical') {
        sketch.constraints.push(new VerticalConstraint(line.id, line.p1.id, line.p2.id));
      }
      if (this._centerSnap) {
        const cs = this.app.snapToConstraint(this._centerSnap, this.center);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      if (!endInfo.reused && snap) {
        const cs = this.app.snapToConstraint(snap, b);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      this.center = null;
      this._centerSnap = null;
      this._centerReused = false;
      this.axisIntent = null;
      this.app.commit();
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) {
    const raw = snap ? { x:snap.x, y:snap.y } : world;
    const axis = this._axisSnapFor(raw, snap);
    this.cursor = axis.point;
    this.axisIntent = axis.kind;
    this.app.requestRender();
  }
  onKey(ev) {
    if (ev.key === 'Escape') {
      this.center = null;
      this._centerSnap = null;
      this._centerReused = false;
      this.axisIntent = null;
      this.app.setTool('select');
    }
  }
  getPreview() {
    if (!this.center || !this.cursor) return null;
    const dx = this.cursor.x - this.center.x;
    const dy = this.cursor.y - this.center.y;
    if (Math.hypot(dx, dy) < EPS) return null;
    return { paths: [[{ x: this.center.x - dx, y: this.center.y - dy }, this.cursor]], dashed: this.app.constructionMode };
  }
}

export class RectangleTool extends Tool {
  constructor(app) { super(app); this.start = null; this.cursor = null; }
  hint() { return 'Click two corners.'; }
  activate() { this.start = null; }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const w = snap ? { x: snap.x, y: snap.y } : world;
    if (!this.start) {
      this.start = w;
      this._startSnap = snap;
    } else {
      const startInfo = this.app.makeOrReusePoint(this.start, this._startSnap, sketch);
      const endInfo   = this.app.makeOrReusePoint(w, snap, sketch);
      const a = startInfo.point;
      const c = endInfo.point;
      const x0 = a.x, y0 = a.y, x1 = c.x, y1 = c.y;
      const b = new Point(x1, y0);
      const d = new Point(x0, y1);
      const l1 = new Line(a, b), l2 = new Line(b, c);
      const l3 = new Line(c, d), l4 = new Line(d, a);
      if (this.app.constructionMode) [l1,l2,l3,l4].forEach(l=>l.construction=true);
      sketch.addEntity(l1); sketch.addEntity(l2);
      sketch.addEntity(l3); sketch.addEntity(l4);
      sketch.constraints.push(new HorizontalConstraint(l1.id, a.id, b.id));
      sketch.constraints.push(new HorizontalConstraint(l3.id, c.id, d.id));
      sketch.constraints.push(new VerticalConstraint  (l2.id, b.id, c.id));
      sketch.constraints.push(new VerticalConstraint  (l4.id, d.id, a.id));
      // Apply snap-derived constraints to the diagonal corners.
      if (!startInfo.reused && this._startSnap) {
        const cs = this.app.snapToConstraint(this._startSnap, a);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      if (!endInfo.reused && snap) {
        const cs = this.app.snapToConstraint(snap, c);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      this.start = null; this._startSnap = null;
      this.app.commit();
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) { this.cursor = snap ? { x:snap.x, y:snap.y } : world; this.app.requestRender(); }
  onKey(ev) { if (ev.key === 'Escape') { this.start = null; this.app.setTool('select'); } }
  getPreview() {
    if (!this.start || !this.cursor) return null;
    const a = this.start, c = this.cursor;
    return { paths: [[ a, {x:c.x,y:a.y}, c, {x:a.x,y:c.y}, a ]], dashed: this.app.constructionMode };
  }
}

export class CenterRectangleTool extends Tool {
  constructor(app) {
    super(app);
    this.center = null;
    this.cursor = null;
    this._centerSnap = null;
    this._centerReused = false;
  }
  hint() { return 'Click center, then a corner.'; }
  activate() {
    this.center = null;
    this.cursor = null;
    this._centerSnap = null;
    this._centerReused = false;
  }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const w = snap ? { x: snap.x, y: snap.y } : world;
    if (!this.center) {
      const info = this.app.makeOrReusePoint(w, snap, sketch);
      this.center = info.point;
      this._centerSnap = info.reused ? null : snap;
      this._centerReused = info.reused;
    } else {
      const sq = centerRectangleCorners(this.center, w);
      if (!sq) return;
      const a = new Point(sq.a.x, sq.a.y);
      const b = new Point(sq.b.x, sq.b.y);
      const c = new Point(sq.c.x, sq.c.y);
      const d = new Point(sq.d.x, sq.d.y);
      const l1 = new Line(a, b), l2 = new Line(b, c);
      const l3 = new Line(c, d), l4 = new Line(d, a);
      const topMid = new Point((a.x + b.x) / 2, (a.y + b.y) / 2);
      const rightMid = new Point((b.x + c.x) / 2, (b.y + c.y) / 2);
      const bottomMid = new Point((c.x + d.x) / 2, (c.y + d.y) / 2);
      const leftMid = new Point((d.x + a.x) / 2, (d.y + a.y) / 2);
      const hCenter = new Line(leftMid, rightMid);
      const vCenter = new Line(topMid, bottomMid);
      hCenter.construction = true;
      vCenter.construction = true;
      if (this.app.constructionMode) [l1,l2,l3,l4].forEach(l => l.construction = true);
      sketch.addEntity(l1); sketch.addEntity(l2);
      sketch.addEntity(l3); sketch.addEntity(l4);
      sketch.addEntity(hCenter); sketch.addEntity(vCenter);
      if (!this._centerReused) sketch.addEntity(this.center);
      sketch.constraints.push(new HorizontalConstraint(l1.id, a.id, b.id));
      sketch.constraints.push(new VerticalConstraint  (l2.id, b.id, c.id));
      sketch.constraints.push(new HorizontalConstraint(l3.id, c.id, d.id));
      sketch.constraints.push(new VerticalConstraint  (l4.id, d.id, a.id));
      sketch.constraints.push(new MidpointConstraint(topMid.id, { a: l1.p1.id, b: l1.p2.id }));
      sketch.constraints.push(new MidpointConstraint(rightMid.id, { a: l2.p1.id, b: l2.p2.id }));
      sketch.constraints.push(new MidpointConstraint(bottomMid.id, { a: l3.p1.id, b: l3.p2.id }));
      sketch.constraints.push(new MidpointConstraint(leftMid.id, { a: l4.p1.id, b: l4.p2.id }));
      sketch.constraints.push(new MidpointConstraint(this.center.id, { a: hCenter.p1.id, b: hCenter.p2.id }));
      if (this._centerSnap) {
        const cs = this.app.snapToConstraint(this._centerSnap, this.center);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      this.center = null;
      this._centerSnap = null;
      this._centerReused = false;
      this.app.commit();
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) {
    this.cursor = snap ? { x:snap.x, y:snap.y } : world;
    this.app.requestRender();
  }
  onKey(ev) {
    if (ev.key === 'Escape') {
      this.center = null;
      this._centerSnap = null;
      this._centerReused = false;
      this.app.setTool('select');
    }
  }
  getPreview() {
    if (!this.center || !this.cursor) return null;
    const sq = centerRectangleCorners(this.center, this.cursor);
    if (!sq) return null;
    return {
      paths: [[sq.a, sq.b, sq.c, sq.d, sq.a]],
      dashed: this.app.constructionMode,
      dashedPaths: [
        [{ x: sq.a.x, y: this.center.y }, { x: sq.c.x, y: this.center.y }],
        [{ x: this.center.x, y: sq.a.y }, { x: this.center.x, y: sq.c.y }]
      ]
    };
  }
}

export class CircleTool extends Tool {
  constructor(app) { super(app); this.center = null; this.cursor = null; }
  hint() { return 'Click center, then a point on the circle.'; }
  activate() { this.center = null; }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const w = snap ? { x:snap.x, y:snap.y } : world;
    if (!this.center) {
      const { point, reused } = this.app.makeOrReusePoint(w, snap, sketch);
      this.center = point;
      this._pendingCenterSnap = reused ? null : snap;
    } else {
      const r = dist(this.center, w);
      const c = new Circle(this.center, r);
      if (this.app.constructionMode) c.construction = true;
      sketch.addEntity(c);
      if (this._pendingCenterSnap) {
        const cs = this.app.snapToConstraint(this._pendingCenterSnap, this.center);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      this.center = null;
      this._pendingCenterSnap = null;
      this.app.commit();
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) { this.cursor = snap ? { x:snap.x, y:snap.y } : world; this.app.requestRender(); }
  onKey(ev) { if (ev.key === 'Escape') { this.center = null; this.app.setTool('select'); } }
  getPreview() {
    if (!this.center || !this.cursor) return null;
    return { circles: [{ center: this.center, r: dist(this.center, this.cursor) }] };
  }
}

export class ThreePointCircleTool extends Tool {
  constructor(app) { super(app); this.picks = []; this.cursor = null; }
  hint() { return 'Click three points on the circle.'; }
  activate() { this.picks = []; this.cursor = null; }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const w = snap ? { x:snap.x, y:snap.y } : world;
    const info = this.app.makeOrReusePoint(w, snap, sketch);
    this.picks.push({ ...info, snap: info.reused ? null : snap });
    if (this.picks.length === 3) {
      const circ = circleFrom3Points(this.picks[0].point, this.picks[1].point, this.picks[2].point);
      if (circ) {
        const center = new Point(circ.center.x, circ.center.y);
        const circle = new Circle(center, circ.r);
        if (this.app.constructionMode) circle.construction = true;
        sketch.addEntity(circle);
        for (const pick of this.picks) {
          if (!pick.reused) sketch.addEntity(pick.point);
        }
        for (const pick of this.picks) {
          sketch.constraints.push(new PointOnCircleConstraint(pick.point.id, circle.id, circle.center.id));
          if (pick.snap) {
            const cs = this.app.snapToConstraint(pick.snap, pick.point);
            if (cs) this.app.admitConstraint(sketch, cs);
          }
        }
        this.app.commit();
      }
      this.picks = [];
      this.cursor = null;
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) {
    this.cursor = snap ? { x:snap.x, y:snap.y } : world;
    this.app.requestRender();
  }
  onKey(ev) {
    if (ev.key === 'Escape') {
      this.picks = [];
      this.cursor = null;
      this.app.setTool('select');
    }
  }
  getPreview() {
    const pts = this.picks.map(p => p.point);
    const points = [...pts];
    if (pts.length === 2 && this.cursor) {
      const circ = circleFrom3Points(pts[0], pts[1], this.cursor);
      if (circ) return { points, circles: [{ center: circ.center, r: circ.r }] };
    }
    if (this.cursor && pts.length > 0 && pts.length < 2) points.push(this.cursor);
    return points.length ? { points } : null;
  }
}

export class HexagonTool extends Tool {
  constructor(app) { super(app); this.center = null; this.cursor = null; }
  hint() { return 'Set sides in Tool Options. Click center, then the midpoint of one edge.'; }
  activate() { this.center = null; this.cursor = null; this._pendingCenterSnap = null; this.app.refreshToolOptions(); }
  deactivate() { this.app.refreshToolOptions(); }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const w = snap ? { x:snap.x, y:snap.y } : world;
    if (!this.center) {
      const { point, reused } = this.app.makeOrReusePoint(w, snap, sketch);
      this.center = point;
      this._pendingCenterSnap = reused ? null : snap;
    } else {
      const pts = regularPolygonFromCenterEdge(this.center, w, this.app.polygonSides);
      if (pts && pts.length >= 3) {
        const vertices = pts.map(p => new Point(p.x, p.y));
        const lines = [];
        const circle = new Circle(this.center, dist(this.center, vertices[0]));
        circle.construction = true;
        for (let i = 0; i < vertices.length; i++) {
          const l = new Line(vertices[i], vertices[(i + 1) % vertices.length]);
          if (this.app.constructionMode) l.construction = true;
          lines.push(l);
        }
        sketch.addEntity(circle);
        for (const l of lines) sketch.addEntity(l);
        for (const p of vertices) {
          sketch.constraints.push(new PointOnCircleConstraint(p.id, circle.id, circle.center.id));
        }
        for (let i = 1; i < lines.length; i++) {
          const equal = new EqualLengthConstraint(
            { a: lines[0].p1.id, b: lines[0].p2.id },
            { a: lines[i].p1.id, b: lines[i].p2.id }
          );
          equal.driven = true;
          sketch.constraints.push(equal);
        }
        const centralAngle = TAU / vertices.length;
        for (let i = 0; i < vertices.length - 1; i++) {
          sketch.constraints.push(new DirectedAngleConstraint(
            { a: this.center.id, b: vertices[i].id },
            { a: this.center.id, b: vertices[(i + 1) % vertices.length].id },
            centralAngle
          ));
        }
        if (this._pendingCenterSnap) {
          const cs = this.app.snapToConstraint(this._pendingCenterSnap, this.center);
          if (cs) this.app.admitConstraint(sketch, cs);
        }
        this.app.commit();
      }
      this.center = null;
      this.cursor = null;
      this._pendingCenterSnap = null;
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) { this.cursor = snap ? { x:snap.x, y:snap.y } : world; this.app.requestRender(); }
  onKey(ev) { if (ev.key === 'Escape') { this.center = null; this._pendingCenterSnap = null; this.app.setTool('select'); } }
  getPreview() {
    if (!this.center || !this.cursor) return null;
    const pts = regularPolygonFromCenterEdge(this.center, this.cursor, this.app.polygonSides);
    if (!pts) return null;
    return {
      paths: [[...pts, pts[0]]],
      circles: [{ center: this.center, r: dist(this.center, pts[0]) }],
      dashed: this.app.constructionMode
    };
  }
}

export class ArcTool extends Tool {
  constructor(app) {
    super(app);
    this.center = null;
    this.start = null;
    this.cursor = null;
    this.dir = 1;
    this.sweep = 0;
    this.lastAngle = null;
    this._pendingCenterSnap = null;
    this._pendingStartSnap = null;
  }
  hint() { return 'Click center, start point, sweep to end point. Tab flips direction.'; }
  activate() {
    this.center = null;
    this.start = null;
    this.cursor = null;
    this.dir = 1;
    this.sweep = 0;
    this.lastAngle = null;
    this._pendingCenterSnap = null;
    this._pendingStartSnap = null;
  }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    const w = snap ? { x:snap.x, y:snap.y } : world;
    if (!this.center) {
      const { point, reused } = this.app.makeOrReusePoint(w, snap, sketch);
      this.center = point;
      this._pendingCenterSnap = reused ? null : snap;
    } else if (!this.start) {
      if (dist(this.center, w) < EPS) return;
      this.start = { x:w.x, y:w.y };
      this.lastAngle = Math.atan2(w.y - this.center.y, w.x - this.center.x);
      this.sweep = 0;
      this._pendingStartSnap = snap;
    } else {
      const arc = this._arcFromCenterStartEnd(this.center, this.start, w);
      if (!arc) return;
      const A = new Arc(this.center, arc.r, arc.a0, arc.a1);
      A.clockwise = arc.clockwise;
      if (this.app.constructionMode) A.construction = true;
      sketch.addEntity(A);
      if (this._pendingCenterSnap) {
        const cs = this.app.snapToConstraint(this._pendingCenterSnap, this.center);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      if (this._pendingStartSnap) {
        const cs = this.app.snapToConstraint(this._pendingStartSnap, A.start);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      if (snap) {
        const cs = this.app.snapToConstraint(snap, A.end);
        if (cs) this.app.admitConstraint(sketch, cs);
      }
      this.center = null;
      this.start = null;
      this.cursor = null;
      this.sweep = 0;
      this.lastAngle = null;
      this._pendingCenterSnap = null;
      this._pendingStartSnap = null;
      this.app.commit();
    }
    this.app.requestRender();
  }
  onPointerMove(world, snap) {
    const w = snap ? { x:snap.x, y:snap.y } : world;
    this.cursor = w;
    if (this.center && this.start && dist(this.center, w) > EPS) {
      const a = Math.atan2(w.y - this.center.y, w.x - this.center.x);
      if (this.lastAngle == null) this.lastAngle = Math.atan2(this.start.y - this.center.y, this.start.x - this.center.x);
      const d = signedAngleDelta(this.lastAngle, a);
      if (Math.abs(d) < Math.PI * 0.95) {
        this.sweep += d;
        if (Math.abs(this.sweep) > 1e-3) this.dir = this.sweep < 0 ? -1 : 1;
      }
      this.lastAngle = a;
    }
    this.app.requestRender();
  }
  onKey(ev) {
    if (ev.key === 'Escape') {
      if (this.start) { this.start = null; this.sweep = 0; this.lastAngle = null; this._pendingStartSnap = null; this.app.requestRender(); }
      else if (this.center) { this.center = null; this.sweep = 0; this.lastAngle = null; this._pendingCenterSnap = null; this._pendingStartSnap = null; this.app.requestRender(); }
      else this.app.setTool('select');
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      this.dir *= -1;
      this.sweep = this.dir * Math.max(Math.abs(this.sweep), 1e-3);
      this.app.requestRender();
    }
  }
  _arcFromCenterStartEnd(center, start, endRef) {
    const r = dist(center, start);
    if (r < EPS || dist(center, endRef) < EPS) return null;
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const endAngle = Math.atan2(endRef.y - center.y, endRef.x - center.x);
    const ccwSpan = normAngle(endAngle - startAngle);
    const cwSpan = normAngle(startAngle - endAngle);
    const span = this.dir > 0 ? ccwSpan : cwSpan;
    if (span < 1e-4 || Math.abs(span - TAU) < 1e-4) return null;
    return {
      r,
      a0:startAngle,
      a1:endAngle,
      clockwise:this.dir < 0,
      end: {
        x: center.x + r * Math.cos(endAngle),
        y: center.y + r * Math.sin(endAngle)
      }
    };
  }
  getPreview() {
    if (!this.center) return null;
    const points = [this.center];
    if (!this.start) {
      if (this.cursor) return { points, paths: [[this.center, this.cursor]], dashed: this.app.constructionMode };
      return { points };
    }
    points.push(this.start);
    if (!this.cursor) return { points };
    const arc = this._arcFromCenterStartEnd(this.center, this.start, this.cursor);
    if (!arc) return { points };
    return {
      points: [...points, arc.end],
      arcs: [{ center:this.center, r:arc.r, a0:arc.a0, a1:arc.a1, clockwise:arc.clockwise }]
    };
  }
}

export class PointTool extends Tool {
  hint() { return 'Click to place a point.'; }
  onPointerDown(world, snap) {
    const sketch = this.app.activeSketch(); if (!sketch) return;
    // Don't create a duplicate at an active-sketch endpoint we already have.
    if (snap && snap.kind === 'endpoint') {
      const owner = this.app.project.sketchOf(snap.entity);
      if (owner && owner.id === sketch.id) return;
    }
    const w = snap ? { x:snap.x, y:snap.y } : world;
    const p = new Point(w.x, w.y);
    sketch.addEntity(p);
    if (snap) {
      const cs = this.app.snapToConstraint(snap, p);
      if (cs) this.app.admitConstraint(sketch, cs);
    }
    this.app.commit();
    this.app.requestRender();
  }
  onKey(ev) { if (ev.key === 'Escape') this.app.setTool('select'); }
}

/** Smart Dimension — three-phase state machine, no browser prompts.
 *
 *  PICKING  : user picks entities one at a time. As soon as the pick set
 *             forms a valid dimension combination (one line, one circle,
 *             two points, line + point, two lines, …) we infer a preview
 *             and transition straight into PLACING.
 *  PLACING  : the dimension follows the cursor — perpendicular offset
 *             for distances, leader angle for radius/diameter, arc
 *             radius for angles. Clicking another entity rebuilds the
 *             pick set (changing the dimension type). Clicking on empty
 *             space freezes the placement and enters TYPING.
 *  TYPING   : an inline input is anchored on the dim label, prefilled
 *             with the measured value. Enter / blur commits, Esc cancels.
 *
 *  The committed constraint stores its label placement (`labelOffset` /
 *  `labelAngle` / `labelDist`) so the dim renders in the same spot on
 *  reload.
 */

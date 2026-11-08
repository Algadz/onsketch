import { EPS, angleArcFromPoints, angleSectorForCursor, dist, lineIntersection, normalizeAngleValue } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { AngleConstraint, CurveDistanceConstraint, DistanceConstraint, PointLineDistanceConstraint, RadiusConstraint, distanceFrame } from '../core/constraints.js';
import { Tool } from './tool.js';

export class SmartDimensionTool extends Tool {
  constructor(app) {
    super(app);
    this.picks = [];
    this.phase = 'picking';   // 'picking' | 'placing' | 'typing'
    this.preview = null;
    this.cursor = null;
    this.inputEl = null;
  }

  hint() {
    if (this.phase === 'typing')  return 'Type a value, Enter to set, Esc to cancel.';
    if (this.phase === 'placing') return 'Click in space to place. Click another entity to change the dimension type. Esc to cancel.';
    return 'Click a line / circle / arc, or two entities, to start a dimension.';
  }

  activate()   { this._reset(); }
  deactivate() { this._cleanup(); }

  _reset() {
    this.picks = [];
    this.phase = 'picking';
    this.preview = null;
    this._removeInput();
  }
  _removeInput() {
    if (this.inputEl) { this.inputEl.dispose(); this.inputEl = null; }
  }
  _cleanup() {
    this._removeInput();
    this._reset();
    this.app.requestRender();
  }

  onPointerDown(world, snap, ev) {
    if (this.phase === 'typing') return;          // input owns events while typing
    const hit = this.app.hitTestForDimension(world);
    if (hit) {
      const idx = this.picks.indexOf(hit);
      if (idx >= 0) this.picks.splice(idx, 1);
      else          this.picks.push(hit);
      this._inferPreview();
      this.phase = this.preview ? 'placing' : 'picking';
      // Keep the default offset/angle/dist that _inferPreview just set —
      // calling _updateCursorPlacement here would zero it out (the click
      // point is on the picked feature itself), making the dim invisible.
      // The next pointermove will start tracking the cursor.
    } else {
      if (this.phase === 'placing' && this.preview) {
        this._updateCursorPlacement(world);
        this._enterTypingPhase();
      }
    }
    this.app.requestRender();
  }

  onPointerMove(world, snap, ev) {
    this.cursor = world;
    if (this.phase === 'placing' && this.preview) {
      this._updateCursorPlacement(world);
      this.app.requestRender();
    }
  }

  onKey(ev) {
    if (this.phase === 'typing') return;
    if (ev.key === 'Escape') {
      if (this.picks.length || this.preview) this._cleanup();
      else this.app.setTool('select');
    }
  }

  /** Inspect the current pick set and build a preview parameter object,
   *  preserving any prior offset/angle/dist when the type doesn't change. */
  _inferPreview() {
    const picks = this.picks;
    const points  = picks.filter(p => p instanceof Point);
    const lines   = picks.filter(p => p instanceof Line);
    const circles = picks.filter(p => p instanceof Circle);
    const arcs    = picks.filter(p => p instanceof Arc);
    const view = this.app.view;
    const defOffset   = 14 / view.zoom;
    const defParallel = 0;
    const defAngle    = Math.PI / 6;
    const defDist     = 40 / view.zoom;
    // Preserve the prior placement when the type is compatible — when the
    // user adds another pick to refine the dimension type, we keep the
    // offset/angle they were already steering toward.
    const oldOffset   = this.preview?.offset   ?? defOffset;
    const oldParallel = this.preview?.parallel ?? defParallel;
    const oldAngle    = this.preview?.angle    ?? defAngle;
    const oldDist     = this.preview?.dist     ?? defDist;

    if (picks.length === 1) {
      if (lines.length === 1) {
        const l = lines[0];
        this.preview = { kind:'distance', p1:l.p1, p2:l.p2,
                          value: dist(l.p1, l.p2),
                          offset: oldOffset, parallel: oldParallel };
        return true;
      }
      if (circles.length === 1) {
        const c = circles[0];
        // Default the cursor distance just outside the rim so the dim is
        // visible immediately after the pick (per "arrow appears on click").
        this.preview = { kind:'diameter', circle:c, value: c.r * 2,
                          angle: oldAngle, dist: c.r + defOffset };
        return true;
      }
      if (arcs.length === 1) {
        const a = arcs[0];
        this.preview = { kind:'radius', circle:a, value: a.r,
                          angle: oldAngle, dist: a.r + defOffset };
        return true;
      }
    }

    if (picks.length === 2) {
      if (points.length === 2) {
        this.preview = { kind:'distance', p1:points[0], p2:points[1],
                          value: dist(points[0], points[1]),
                          offset: oldOffset, parallel: oldParallel };
        return true;
      }
      if (lines.length === 2) {
        const [a, b] = lines;
        const sector = angleSectorForCursor(a, b, this.cursor);
        if (!sector) { this.preview = null; return false; }
        this.preview = {
          kind:'angle', l1:a, l2:b,
          value: sector.value, dist: oldDist,
          midAngle: sector.midAngle,
          l1Ref: sector.l1Ref, l2Ref: sector.l2Ref
        };
        return true;
      }
      if (lines.length === 1 && points.length === 1) {
        const l = lines[0], p = points[0];
        const dx = l.p2.x - l.p1.x, dy = l.p2.y - l.p1.y;
        const len = Math.hypot(dx, dy);
        const cur = len < EPS ? 0 : Math.abs(dx*(p.y-l.p1.y) - dy*(p.x-l.p1.x)) / len;
        this.preview = { kind:'pointLineDistance', p:p, line:l, value: cur,
                          offset: oldOffset, parallel: oldParallel };
        return true;
      }
      if ((circles.length + arcs.length) === 2) {
        const all = [...circles, ...arcs];
        const d = dist(all[0].center, all[1].center);
        if (d < EPS) {
          const outer = all[0].r >= all[1].r ? all[0] : all[1];
          const inner = outer === all[0] ? all[1] : all[0];
          this.preview = {
            kind:'curveDistance', mode:'radial', c1:outer, c2:inner,
            value: Math.abs(outer.r - inner.r),
            angle: oldAngle, dist: Math.max(outer.r, inner.r) + defOffset
          };
          return true;
        }
        if (this._cursorSuggestsCurveGap(all[0], all[1], this.cursor)) {
          const gap = Math.max(0, d - all[0].r - all[1].r);
          this.preview = {
            kind:'curveDistance', mode:'gap', c1:all[0], c2:all[1],
            value: gap, offset: oldOffset, parallel: oldParallel
          };
          return true;
        }
        this.preview = { kind:'distance', p1:all[0].center, p2:all[1].center,
                          value: d, offset: oldOffset, parallel: oldParallel };
        return true;
      }
    }

    this.preview = null;
    return false;
  }

  /** Resolve cursor world position into the appropriate placement field.
   *  For distance dims we capture BOTH a perpendicular offset and a parallel
   *  offset along the line direction, so the text rides exactly under the
   *  cursor (which may be past either arrow). For circle dims we capture
   *  the cursor's distance from the center as well as its angle, so the
   *  user picks inside-vs-outside by pulling the cursor in or out. */
  _updateCursorPlacement(world) {
    if (!this.preview) return;
    const p = this.preview;
    if (p.kind === 'distance') {
      if (Math.hypot(p.p2.x - p.p1.x, p.p2.y - p.p1.y) < EPS) return;
      // Slanted line / point pair: where the cursor is picks the type, as
      // in SolidWorks. Above or below it → horizontal (X), left or right of
      // it → vertical (Y), beside it along its slant → the true length.
      p.axis = this._distanceAxisFor(p.p1, p.p2, world);
      const fr = distanceFrame(p.p1, p.p2, p.axis);
      p.value = fr.len;
      const wx = world.x - fr.mid.x, wy = world.y - fr.mid.y;
      p.offset   = wx * fr.n.x + wy * fr.n.y;
      p.parallel = wx * fr.t.x + wy * fr.t.y;
    } else if (p.kind === 'curveDistance') {
      if (p.mode === 'gap') {
        const geom = this._curveGapEndpoints(p.c1, p.c2);
        if (!geom) return;
        const dx = geom.p2.x - geom.p1.x, dy = geom.p2.y - geom.p1.y;
        const len = Math.hypot(dx, dy);
        if (len < EPS) return;
        const nx = -dy / len, ny = dx / len;
        const tx =  dx / len, ty =  dy / len;
        const mid = { x: (geom.p1.x + geom.p2.x)/2, y: (geom.p1.y + geom.p2.y)/2 };
        const wx = world.x - mid.x, wy = world.y - mid.y;
        p.offset   = wx * nx + wy * ny;
        p.parallel = wx * tx + wy * ty;
      } else if (p.mode === 'radial') {
        const dx = world.x - p.c1.center.x;
        const dy = world.y - p.c1.center.y;
        const d = Math.hypot(dx, dy);
        if (d > EPS) {
          p.angle = Math.atan2(dy, dx);
          p.dist = d;
        }
      }
    } else if (p.kind === 'pointLineDistance') {
      const dx = p.line.p2.x - p.line.p1.x, dy = p.line.p2.y - p.line.p1.y;
      const len = Math.hypot(dx, dy);
      if (len < EPS) return;
      const t = ((p.p.x - p.line.p1.x)*dx + (p.p.y - p.line.p1.y)*dy) / (len*len);
      const foot = { x: p.line.p1.x + t*dx, y: p.line.p1.y + t*dy };
      const segDx = foot.x - p.p.x, segDy = foot.y - p.p.y;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen < EPS) return;
      const segNx = -segDy / segLen, segNy = segDx / segLen;
      const segTx =  segDx / segLen, segTy =  segDy / segLen;
      const mid = { x: (p.p.x + foot.x)/2, y: (p.p.y + foot.y)/2 };
      const wx = world.x - mid.x, wy = world.y - mid.y;
      p.offset   = wx * segNx + wy * segNy;
      p.parallel = wx * segTx + wy * segTy;
    } else if (p.kind === 'radius' || p.kind === 'diameter') {
      const dx = world.x - p.circle.center.x;
      const dy = world.y - p.circle.center.y;
      const d = Math.hypot(dx, dy);
      if (d > EPS) {
        p.angle = Math.atan2(dy, dx);
        p.dist  = d;
      }
    } else if (p.kind === 'angle') {
      const inter = lineIntersection(p.l1.p1, p.l1.p2, p.l2.p1, p.l2.p2);
      const sector = angleSectorForCursor(p.l1, p.l2, world);
      if (inter) p.dist = Math.max(dist(inter, world), 12 / this.app.view.zoom);
      if (sector) {
        p.value = sector.value;
        p.midAngle = sector.midAngle;
        p.l1Ref = sector.l1Ref;
        p.l2Ref = sector.l2Ref;
      }
    }
  }

  /** X, Y or aligned for a distance between a and b, from the cursor:
   *  past the pair's extent vertically (but within it horizontally) →
   *  'x'; past it horizontally (within it vertically) → 'y'; anywhere
   *  else (beside the slant, or off a corner) → null, the true length.
   *  A horizontal or vertical pair is always aligned: its length already
   *  is its X or Y. */
  _distanceAxisFor(a, b, w) {
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const tiny = 1e-6 * Math.max(dx, dy, 1);
    if (dx <= tiny || dy <= tiny) return null;
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const inX = w.x > minX && w.x < maxX, inY = w.y > minY && w.y < maxY;
    if (inX && !inY) return 'x';
    if (inY && !inX) return 'y';
    return null;
  }

  _enterTypingPhase() {
    this.phase = 'typing';
    this._showInput();
  }

  _showInput() {
    if (!this.preview) return;
    const pos = this._labelScreenPos();
    if (!pos) { this._cleanup(); return; }

    const p = this.preview;
    let initial;
    if (p.kind === 'angle')          initial = normalizeAngleValue(p.value) * 180 / Math.PI;
    else                              initial = (p.kind === 'diameter') ? p.value : Math.abs(p.value);
    const angular = p.kind === 'angle';

    // Accepts units (4in, 25mm, 30deg) and equations (=D1*2).
    this.inputEl = this.app.openValueInput(pos, Number(Number(initial).toFixed(3)).toString(), (text) => {
      let parsed;
      try { parsed = this.app.parseDimensionInput(text, null, angular); }
      catch (e) { return e.message; }
      this.inputEl = null;
      this._commit(parsed.value, parsed.expr);
      this._reset();
      this.app.requestRender();
      return null;
    }, () => {
      this.inputEl = null;
      this._reset();
      this.app.requestRender();
    });
  }

  _labelScreenPos() {
    const view = this.app.view;
    const p = this.preview;
    if (p.kind === 'distance') {
      const fr = distanceFrame(p.p1, p.p2, p.axis);
      if (fr.len < EPS) return null;
      const par = p.parallel || 0;
      return view.worldToScreen({
        x: fr.mid.x + fr.n.x * p.offset + fr.t.x * par,
        y: fr.mid.y + fr.n.y * p.offset + fr.t.y * par
      });
    }
    if (p.kind === 'curveDistance') {
      if (p.mode === 'gap') {
        const geom = this._curveGapEndpoints(p.c1, p.c2);
        if (!geom) return null;
        const dx = geom.p2.x - geom.p1.x, dy = geom.p2.y - geom.p1.y;
        const len = Math.hypot(dx, dy); if (len < EPS) return null;
        const nx = -dy / len, ny = dx / len;
        const tx =  dx / len, ty =  dy / len;
        const par = p.parallel || 0;
        return view.worldToScreen({
          x: (geom.p1.x + geom.p2.x)/2 + nx * p.offset + tx * par,
          y: (geom.p1.y + geom.p2.y)/2 + ny * p.offset + ty * par
        });
      }
      if (p.mode === 'radial') {
        const dPos = (p.dist != null) ? p.dist : (p.c1.r + 14 / view.zoom);
        return view.worldToScreen({
          x: p.c1.center.x + dPos * Math.cos(p.angle),
          y: p.c1.center.y + dPos * Math.sin(p.angle)
        });
      }
    }
    if (p.kind === 'pointLineDistance') {
      const dx = p.line.p2.x - p.line.p1.x, dy = p.line.p2.y - p.line.p1.y;
      const len = Math.hypot(dx, dy); if (len < EPS) return null;
      const t = ((p.p.x - p.line.p1.x)*dx + (p.p.y - p.line.p1.y)*dy) / (len*len);
      const foot = { x: p.line.p1.x + t*dx, y: p.line.p1.y + t*dy };
      const segDx = foot.x - p.p.x, segDy = foot.y - p.p.y;
      const segLen = Math.hypot(segDx, segDy) || 1;
      const segNx = -segDy / segLen, segNy = segDx / segLen;
      const segTx =  segDx / segLen, segTy =  segDy / segLen;
      const par = p.parallel || 0;
      return view.worldToScreen({
        x: (p.p.x + foot.x)/2 + segNx * p.offset + segTx * par,
        y: (p.p.y + foot.y)/2 + segNy * p.offset + segTy * par
      });
    }
    if (p.kind === 'radius' || p.kind === 'diameter') {
      const r = p.circle.r;
      const dPos = (p.dist != null) ? p.dist : (r + 14 / view.zoom);
      return view.worldToScreen({
        x: p.circle.center.x + dPos * Math.cos(p.angle),
        y: p.circle.center.y + dPos * Math.sin(p.angle)
      });
    }
    if (p.kind === 'angle') {
      const inter = lineIntersection(p.l1.p1, p.l1.p2, p.l2.p1, p.l2.p2);
      if (!inter) return null;
      const ref1 = p.l1Ref || { a:p.l1.p1.id, b:p.l1.p2.id };
      const ref2 = p.l2Ref || { a:p.l2.p1.id, b:p.l2.p2.id };
      const pts = new Map([
        [p.l1.p1.id, p.l1.p1], [p.l1.p2.id, p.l1.p2],
        [p.l2.p1.id, p.l2.p1], [p.l2.p2.id, p.l2.p2]
      ]);
      if (!pts.get(ref1.a) || !pts.get(ref1.b) || !pts.get(ref2.a) || !pts.get(ref2.b)) return null;
      const arc = angleArcFromPoints(pts.get(ref1.a), pts.get(ref1.b), pts.get(ref2.a), pts.get(ref2.b));
      const mid = arc.midAngle;
      const labelDist = (p.dist ?? (40 / view.zoom)) + 12 / view.zoom;
      return view.worldToScreen({
        x: inter.x + labelDist * Math.cos(mid),
        y: inter.y + labelDist * Math.sin(mid)
      });
    }
    return null;
  }

  _commit(value, expr = null) {
    const sketch = this.app.activeSketch();
    if (!sketch) return;
    const p = this.preview;
    let made = null;
    if (p.kind === 'distance') {
      made = new DistanceConstraint(p.p1.id, p.p2.id, value, p.axis);
      made.labelOffset   = p.offset;
      made.labelParallel = p.parallel || 0;
    } else if (p.kind === 'curveDistance') {
      made = new CurveDistanceConstraint(p.c1.id, p.c2.id, p.mode, value);
      if (p.mode === 'gap') {
        made.labelOffset = p.offset;
        made.labelParallel = p.parallel || 0;
      } else {
        made.labelAngle = p.angle;
        made.labelDist = p.dist;
      }
    } else if (p.kind === 'pointLineDistance') {
      made = new PointLineDistanceConstraint(p.p.id, { a: p.line.p1.id, b: p.line.p2.id }, value);
      made.labelOffset   = p.offset;
      made.labelParallel = p.parallel || 0;
    } else if (p.kind === 'radius') {
      made = new RadiusConstraint(p.circle.id, value);
      made.labelAngle = p.angle;
      made.labelDist  = p.dist;
    } else if (p.kind === 'diameter') {
      made = new RadiusConstraint(p.circle.id, value / 2);
      made.labelAngle = p.angle;
      made.labelDist  = p.dist;
      made.isDiameter = true;
    } else if (p.kind === 'angle') {
      made = new AngleConstraint(
        p.l1Ref || { a: p.l1.p1.id, b: p.l1.p2.id },
        p.l2Ref || { a: p.l2.p1.id, b: p.l2.p2.id },
        normalizeAngleValue(value * Math.PI / 180));
      made.labelDist = p.dist;
      made.labelMidAngle = p.midAngle;
    }
    if (made) {
      if (expr) made.expr = expr;
      sketch.constraints.push(made);
      // Run a probe solve. If adding this dimension would over-define the
      // sketch, demote it to a "driven" dimension — informational only,
      // doesn't enforce. SolidWorks asks the user; we just do it silently
      // and render in grey.
      const affectedIds = made.refs();
      const probe = this.app.solver.solve(sketch, this.app.project.sketches, [], {
        diagnostics:true,
        activeIds:affectedIds
      });
      if (probe.state === 'over' || (probe.redundantIds && probe.redundantIds.has(made.id))) {
        made.driven = true;
        made.expr = null;
      }
      this.app.commit({ activeIds: affectedIds });
      this.app.refreshUI();
    }
  }

  getPreview() { return { dimPicks: this.picks, dimPreview: this.preview, dimPhase: this.phase }; }
}

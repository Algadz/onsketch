import { EPS, angleSectorForCursor, dist, lineIntersection } from '../core/math.js';
import { Line } from '../core/entities.js';
import { distanceFrame } from '../core/constraints.js';

export class DimensionLabelsMixin {

  /** Hit-test in screen pixels against the rectangles the renderer recorded
   *  for every drawn dimension label. Used to detect select / edit /
   *  drag-to-reposition on existing dims. */
  /** Relation badge under a screen point (active layer only). */
  hitRelationAtScreen(sx, sy) {
    const rects = this.renderer.lastRelRects || [];
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      const m = 0;                 // badges are already enlarged for touch
      if (sx >= r.x - m && sx <= r.x + r.w + m && sy >= r.y - m && sy <= r.y + r.h + m) return r.constraint;
    }
    return null;
  }

  hitDimAtScreen(sx, sy) {
    const rects = this.renderer.lastDimRects || [];
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      const m = this._hitPad() / 2;   // touch: a little extra around labels
      if (sx >= r.x - m && sx <= r.x + r.w + m && sy >= r.y - m && sy <= r.y + r.h + m) return r.constraint;
    }
    return null;
  }

  /** Move an existing dimension's label based on the cursor world position.
   *  Updates labelOffset / labelAngle / labelDist on the constraint. */
  moveDimLabel(c, world) {
    if (c.kind === 'distance' || c.kind === 'pointLineDistance' || c.kind === 'curveDistance' || c.kind === 'offsetDistance') {
      let p1, p2;
      if (c.kind === 'distance') {
        p1 = this._lookupAny(c.p1); p2 = this._lookupAny(c.p2);
      } else if (c.kind === 'offsetDistance') {
        // Use geometry of the first pair for label placement
        const first = c.pairs && c.pairs[0];
        if (!first) return;
        if (first.kind === 'line') {
          const src = this._lookupAny(first.sourceEntityId);
          const dst = this._lookupAny(first.targetEntityId);
          const pt = dst instanceof Line
            ? { x:(dst.p1.x + dst.p2.x) / 2, y:(dst.p1.y + dst.p2.y) / 2 }
            : this._lookupAny(first.pointId);
          const la = src instanceof Line ? src.p1 : this._lookupAny(first.l.a);
          const lb = src instanceof Line ? src.p2 : this._lookupAny(first.l.b);
          if (!pt || !la || !lb) return;
          const dx = lb.x - la.x, dy = lb.y - la.y;
          const len2 = dx*dx + dy*dy; if (len2 < EPS) return;
          const t = ((pt.x - la.x)*dx + (pt.y - la.y)*dy) / len2;
          p1 = pt; p2 = { x: la.x + t*dx, y: la.y + t*dy };
        } else {
          const a = this._lookupAny(first.c1), b = this._lookupAny(first.c2);
          if (!a || !b) return;
          if (c.mode === 'gap') {
            const dx = b.center.x - a.center.x, dy = b.center.y - a.center.y;
            const d = Math.hypot(dx, dy); if (d < EPS) return;
            const ux = dx / d, uy = dy / d;
            p1 = { x: a.center.x + ux * a.r, y: a.center.y + uy * a.r };
            p2 = { x: b.center.x - ux * b.r, y: b.center.y - uy * b.r };
          } else {
            const outer = a.r >= b.r ? a : b;
            const inner = outer === a ? b : a;
            const angle = (c.labelAngle != null) ? c.labelAngle : Math.PI / 6;
            p1 = { x: inner.center.x + inner.r * Math.cos(angle), y: inner.center.y + inner.r * Math.sin(angle) };
            p2 = { x: outer.center.x + outer.r * Math.cos(angle), y: outer.center.y + outer.r * Math.sin(angle) };
          }
        }
      } else if (c.kind === 'curveDistance') {
        const a = this._lookupAny(c.c1), b = this._lookupAny(c.c2);
        if (!a || !b) return;
        if (c.mode === 'gap') {
          const dx = b.center.x - a.center.x, dy = b.center.y - a.center.y;
          const d = Math.hypot(dx, dy); if (d < EPS) return;
          const ux = dx / d, uy = dy / d;
          p1 = { x: a.center.x + ux * a.r, y: a.center.y + uy * a.r };
          p2 = { x: b.center.x - ux * b.r, y: b.center.y - uy * b.r };
        } else {
          const outer = a.r >= b.r ? a : b;
          const inner = outer === a ? b : a;
          const angle = (c.labelAngle != null) ? c.labelAngle : Math.PI / 6;
          p1 = { x: inner.center.x + inner.r * Math.cos(angle), y: inner.center.y + inner.r * Math.sin(angle) };
          p2 = { x: outer.center.x + outer.r * Math.cos(angle), y: outer.center.y + outer.r * Math.sin(angle) };
        }
      } else {
        const pt = this._lookupAny(c.pointId);
        const la = this._lookupAny(c.l.a), lb = this._lookupAny(c.l.b);
        if (!pt || !la || !lb) return;
        const dx = lb.x - la.x, dy = lb.y - la.y;
        const len2 = dx*dx + dy*dy; if (len2 < EPS) return;
        const t = ((pt.x - la.x)*dx + (pt.y - la.y)*dy) / len2;
        p1 = pt; p2 = { x: la.x + t*dx, y: la.y + t*dy };
      }
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy); if (len < EPS) return;
      const nx = -dy / len, ny = dx / len;
      const tx =  dx / len, ty =  dy / len;
      const mid = { x: (p1.x + p2.x)/2, y: (p1.y + p2.y)/2 };
      const wx = world.x - mid.x, wy = world.y - mid.y;
      const isRadialCircle = (c.kind === 'curveDistance' && c.mode === 'radial') ||
        (c.kind === 'offsetDistance' && c.pairs && c.pairs[0] && c.pairs[0].kind === 'circle');
      if (isRadialCircle) {
        let anchor = mid;
        if (c.kind === 'curveDistance') {
          const outer = this._lookupAny(c.c1), inner = this._lookupAny(c.c2);
          if (outer && inner) anchor = (outer.r >= inner.r ? outer.center : inner.center);
        } else {
          const first = c.pairs[0];
          const a = this._lookupAny(first.c1), b = this._lookupAny(first.c2);
          if (a && b) anchor = (a.r >= b.r ? a.center : b.center);
        }
        const dxw = world.x - anchor.x, dyw = world.y - anchor.y;
        const dw = Math.hypot(dxw, dyw);
        if (dw > EPS) {
          c.labelAngle = Math.atan2(dyw, dxw);
          c.labelDist = dw;
        }
      } else if (c.kind === 'distance' && c.axis) {
        // horizontal / vertical distance: offset along its own frame
        const fr = distanceFrame(p1, p2, c.axis);
        const ox = world.x - fr.mid.x, oy = world.y - fr.mid.y;
        c.labelOffset   = ox * fr.n.x + oy * fr.n.y;
        c.labelParallel = ox * fr.t.x + oy * fr.t.y;
      } else {
        c.labelOffset   = wx * nx + wy * ny;
        c.labelParallel = wx * tx + wy * ty;
      }
    } else if (c.kind === 'radius') {
      const circ = this._lookupAny(c.circleId); if (!circ) return;
      const dx = world.x - circ.center.x, dy = world.y - circ.center.y;
      const d = Math.hypot(dx, dy);
      if (d > EPS) {
        c.labelAngle = Math.atan2(dy, dx);
        c.labelDist  = d;
      }
    } else if (c.kind === 'angle') {
      const a1 = this._lookupAny(c.l1.a), b1 = this._lookupAny(c.l1.b);
      const a2 = this._lookupAny(c.l2.a), b2 = this._lookupAny(c.l2.b);
      if (!a1 || !b1 || !a2 || !b2) return;
      const inter = lineIntersection(a1, b1, a2, b2);
      if (!inter) return;
      const sector = angleSectorForCursor({ p1:a1, p2:b1 }, { p1:a2, p2:b2 }, world);
      c.labelDist = Math.max(dist(inter, world), 12 / this.view.zoom);
      if (sector) {
        c.value = sector.value;
        c.labelMidAngle = sector.midAngle;
        c.l1 = sector.l1Ref;
        c.l2 = sector.l2Ref;
      }
    }
  }

  /** Project-wide id → entity lookup. */
  _lookupAny(id) {
    for (const s of this.project.sketches) {
      for (const e of s.entities) {
        if (e.id === id) return e;
        for (const c of e.children()) if (c.id === id) return c;
      }
    }
    return null;
  }

  _lookupMap(sketches = this.project.sketches) {
    const byId = new Map();
    const walk = (e) => {
      byId.set(e.id, e);
      for (const c of e.children()) walk(c);
    };
    for (const s of sketches) for (const e of s.entities) walk(e);
    return byId;
  }

  _lookupFn(sketches = this.project.sketches) {
    const byId = this._lookupMap(sketches);
    return (id, key) => {
      const e = byId.get(id);
      return e ? e[key] : 0;
    };
  }

  /** Open an inline input over a dimension's label so the user can edit
   *  the value (or Esc to leave it untouched). Reuses the SmartDim input
   *  styling. */
  editDimValue(c) {
    if (!c || c.driven) return;
    const rect = (this.renderer.lastDimRects || []).find(r => r.constraint === c);
    if (!rect) return;
    // Shows the equation when there is one (like SolidWorks), else the value.
    this.openValueInput({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, this.dimensionEditText(c),
      (text) => this.setDimensionFromText(c, text), () => {}, { selfName: c.name });
  }

}

import { Arc, Bezier, Line, Point } from '../core/entities.js';
import { CurveTangentConstraint, SmoothConstraint } from '../core/constraints.js';
import { Tool } from './tool.js';
import { trackOnce } from '../ui/analytics.js';

/* =============== CURVE TOOL (V): CUBIC BÉZIER PATHS =============
   Like a pen tool, segment by segment:
     click            a point. With "Smooth clicks" (the default) the path
                      goes through it without a kink: its handles line up
                      with the points either side, and a Smooth relation
                      keeps them so. With "Corner clicks", a kink.
     press + drag     pull out the point's handle yourself (Shift: 15°
                      steps); the other side mirrors it (Smooth).
     start / end on   the free end of a line, an arc or another curve:
                      the curve continues it (Tangent / Smooth relation)
                      unless you drag a handle the other way. At a corner
                      of two shapes it doesn't guess.
     click the first point: closes the path. Enter, Esc or a double-click
     ends it (Esc again: Select). Each segment is one undo step.
   Points snap like the line tool's (ends, middles, on line / circle /
   curve…). Handles of a finished curve show when it's selected: drag them
   with Select to reshape it.
   ============================================================ */

const TAU = Math.PI * 2;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const unit = (a) => { const l = len(a); return l > 1e-12 ? { x: a.x / l, y: a.y / l } : null; };
const ANGLE_SNAP = 8 * Math.PI / 180;        // a drag this close to a tangent snaps onto it

export class BezierTool extends Tool {
  constructor(app) {
    super(app);
    this._reset();
  }
  _reset() {
    this.anchors = [];          // [{ pt, out: {x,y}|null (handle vector), smooth, auto, tangent }]
    this.segs = [];             // curves made in this path, in order
    this.press = null;          // pointer held: { raw, snap, close, drag: vec|null }
    this.cursor = null;
    this.cursorSnap = null;
    this._autoPrev = null;      // previous segment's c2 while it follows the cursor (smooth clicks)
  }
  get smoothClicks() { return this.app.curveClicks !== 'corner'; }
  hint() {
    if (!this.anchors.length) return 'Curve: click points (drag to pull a handle). Start on a line or curve end to continue it smoothly.';
    return 'Click the next point, drag for a handle (Shift: 15° steps). Click the first point to close; Enter, Esc or double-click to finish.';
  }
  activate() { this._reset(); }
  deactivate() { this.finish(); }

  _sketch() { return this.app.activeSketch(); }
  _hint() { const el = document.getElementById('status-hint'); if (el) el.textContent = this.hint(); }

  /* ---- what an anchor continues (tangency at a snapped end) ---- */

  /** Direction a path leaving point p should take to continue the shape
   *  ending there, with the relation that keeps it: null when nothing ends there. */
  _continuation(snapPoint) {
    const sketch = this._sketch();
    if (!snapPoint || !sketch) return null;
    // Only a free end is continued: at a corner of two shapes, which one
    // to follow would be a guess.
    const ending = sketch.entities.filter(e => (e instanceof Line || e instanceof Bezier) && !this.segs.includes(e) && (e.p1 === snapPoint || e.p2 === snapPoint));
    if (ending.length + (snapPoint.arcOwner instanceof Arc ? 1 : 0) !== 1) return null;
    if (snapPoint.arcOwner instanceof Arc) {
      const arc = snapPoint.arcOwner;
      arc.syncEnds();
      const a = snapPoint.arcEndpoint === 'start' ? arc.a0 : arc.a1;
      const ccw = arc.clockwise ? -1 : 1;
      // travel direction along the arc at that end, then away from the arc
      let t = { x: -Math.sin(a) * ccw, y: Math.cos(a) * ccw };
      if (snapPoint.arcEndpoint === 'start') t = mul(t, -1);
      return { dir: t, target: { circle: arc.id, centerId: arc.center.id } };
    }
    for (const e of ending) {
      if (e instanceof Line && (e.p1 === snapPoint || e.p2 === snapPoint)) {
        const other = e.p1 === snapPoint ? e.p2 : e.p1;
        const dir = unit(sub(snapPoint, other));
        if (dir) return { dir, target: { line: { a: e.p1.id, b: e.p2.id } } };
      }
      if (e instanceof Bezier && (e.p1 === snapPoint || e.p2 === snapPoint) && !this.segs.includes(e)) {
        const h = e.p1 === snapPoint ? e.c1 : e.c2;
        const dir = unit(sub(snapPoint, h));
        if (dir) return { dir, smoothWith: h };
      }
    }
    return null;
  }

  /** Point the press / cursor stands for: snapped or raw. */
  _spot(world, snap) { return snap ? { x: snap.x, y: snap.y } : world; }

  /** Handle vector from a drag (Shift: 15° steps), snapped onto a tangent
   *  direction when close to it. Returns { vec, onTangent }. */
  _dragVec(anchor, world, ev, cont) {
    let v = sub(world, anchor);
    if (ev?.shiftKey) {
      const a = Math.round(Math.atan2(v.y, v.x) / (TAU / 24)) * (TAU / 24), l = len(v);
      v = { x: Math.cos(a) * l, y: Math.sin(a) * l };
    }
    if (cont) {
      const u = unit(v);
      if (u && Math.acos(Math.max(-1, Math.min(1, u.x * cont.dir.x + u.y * cont.dir.y))) < ANGLE_SNAP) {
        return { vec: mul(cont.dir, len(v)), onTangent: true };
      }
    }
    return { vec: v, onTangent: false };
  }

  /* ---- pointer ---- */

  onPointerDown(world, snap, ev) {
    const sketch = this._sketch(); if (!sketch) return;
    if (ev && ev.detail >= 2 && this.anchors.length) { this.finish(); return; }
    const raw = this._spot(world, snap);
    const first = this.anchors[0];
    const close = this.anchors.length >= 2 && first &&
      ((snap && snap.entity === first.pt) || Math.hypot(raw.x - first.pt.x, raw.y - first.pt.y) * this.app.view.zoom < 8);
    this.press = { raw: close ? { x: first.pt.x, y: first.pt.y } : raw, snap: close ? null : snap, close, drag: null, world };
    this.app.requestRender();
  }

  onPointerMove(world, snap, ev) {
    if (this.press) {
      const px = Math.hypot(world.x - this.press.world.x, world.y - this.press.world.y) * this.app.view.zoom;
      if (px > 4 || this.press.drag) {
        const cont = this.press.close ? null : this._continuation(this.press.snap?.entity instanceof Point ? this.press.snap.entity : null);
        this.press.drag = this._dragVec(this.press.raw, world, ev, cont);
      }
      this.app.requestRender();
      return;
    }
    this.cursor = this._spot(world, snap);
    this.cursorSnap = snap;
    this._followCursor();
    this.app.requestRender();
  }

  onPointerUp(world, snap, ev) {
    const pr = this.press;
    this.press = null;
    if (!pr) return;
    const sketch = this._sketch(); if (!sketch) return;
    if (pr.close) { this._place(sketch, this.anchors[0].pt, null, pr.drag, true); this.finish(); return; }
    const { point, reused } = this.app.makeOrReusePoint(pr.raw, pr.snap, sketch);
    if (this.anchors.length && point === this.anchors[this.anchors.length - 1].pt) return;   // same point twice
    if (this.anchors.length) {
      const last = this.anchors[this.anchors.length - 1].pt;
      if (Math.hypot(point.x - last.x, point.y - last.y) * this.app.view.zoom < 3) return;
    }
    const snapPoint = pr.snap?.kind === 'endpoint' && pr.snap.entity instanceof Point ? pr.snap.entity : null;
    this._place(sketch, point, reused ? null : pr.snap, pr.drag, false, snapPoint);
    this._hint();
    this.app.requestRender();
  }

  onKey(ev) {
    if (ev.key === 'Escape' || ev.key === 'Enter') {
      if (this.anchors.length) this.finish();
      else if (ev.key === 'Escape') this.app.setTool('select');
    }
  }

  /* ---- building the path ---- */

  /** Handle length for a chord: a third of it, like a smooth spline. */
  _hlen(a, b) { return Math.hypot(b.x - a.x, b.y - a.y) / 3; }

  /**
   * Adds an anchor (and the segment to it). `drag` is the handle pulled
   * at this point ({vec, onTangent}) or null for a click. `snapPoint` is
   * the existing point snapped onto (for tangency).
   */
  _place(sketch, pt, pendingSnap, drag, closing, snapPoint = null) {
    const cont = closing ? null : this._continuation(snapPoint);
    const anchor = {
      pt, pendingSnap,
      out: drag ? drag.vec : null,
      smooth: drag ? true : this.smoothClicks,
      auto: !drag,
      cont: (!drag || drag.onTangent) ? cont : null,      // continue the shape there?
    };
    if (closing) Object.assign(anchor, this.anchors[0], { pt: this.anchors[0].pt });
    const prev = this.anchors[this.anchors.length - 1];
    if (!prev) {                      // first point: nothing to draw yet
      this.anchors.push(anchor);
      return;
    }
    this._restoreAutoPrev(false);     // the previous c2 is settled now (below)
    const A = prev.pt, B = pt;
    const chordAB = this._hlen(A, B);

    // Handle leaving A
    let c1;
    if (prev.out) c1 = add(A, prev.out);
    else if (prev.cont) c1 = add(A, mul(prev.cont.dir, chordAB));
    else if (prev.smooth && prev.inDir) c1 = add(A, mul(prev.inDir, chordAB));
    else c1 = add(A, mul(sub(B, A), 1 / 3));

    // Handle arriving at B
    let c2;
    const arrive = closing ? this._closingArrive(anchor, drag) : null;
    if (arrive) c2 = arrive;
    else if (drag) c2 = sub(B, drag.vec);                                   // mirrored pulled handle
    else if (anchor.cont) c2 = sub(B, mul(anchor.cont.dir, -chordAB));      // into the shape we join
    else c2 = add(B, mul(sub(A, B), 1 / 3));

    const curve = new Bezier(A, new Point(c1.x, c1.y), new Point(c2.x, c2.y), B);
    if (this.app.constructionMode) curve.construction = true;
    sketch.addEntity(curve);
    // snaps of points that are new to the sketch
    for (const a of [prev, anchor]) {
      if (a.pendingSnap) {
        const cs = this.app.snapToConstraint(a.pendingSnap, a.pt);
        if (cs) this.app.admitConstraint(sketch, cs, { quiet: true });
        a.pendingSnap = null;
      }
    }
    // relations: smooth through A, tangent continuations at A and B
    const prevSeg = this.segs[this.segs.length - 1];
    if (prevSeg && prev.smooth) sketch.constraints.push(new SmoothConstraint(A.id, prevSeg.c2.id, curve.c1.id));
    if (!prevSeg && prev.cont) this._relateContinuation(sketch, prev.cont, A, curve.c1);
    if (!closing && anchor.cont) this._relateContinuation(sketch, anchor.cont, B, curve.c2);
    if (closing && anchor.smooth) sketch.constraints.push(new SmoothConstraint(B.id, curve.c2.id, this.segs[0].c1.id));

    this.segs.push(curve);
    anchor.inDir = unit(sub(B, c2));            // direction we arrive with (for smooth clicks)
    if (drag) anchor.out = drag.vec;
    this.anchors.push(anchor);
    this.app.commit({ activeIds: curve.children().map(p => p.id) });
    this.app.refreshUI();
    trackOnce('curve', { clicks: this.smoothClicks ? 'smooth' : 'corner' });
  }
  /** Closing on the first point: its handles line up (smooth) unless it was a corner. */
  _closingArrive(first, drag) {
    const seg0 = this.segs[0];
    const B = first.pt;
    if (drag) return sub(B, drag.vec);
    if (!first.smooth || !seg0) return null;
    // mirror the first segment's leaving handle (same length as the chord third)
    const prev = this.anchors[this.anchors.length - 1].pt;
    const dir = unit(sub(seg0.c1, B)) || unit(sub(seg0.p2, B));
    if (!dir) return null;
    return sub(B, mul(dir, this._hlen(prev, B)));
  }

  _relateContinuation(sketch, cont, anchorPt, handle) {
    if (cont.smoothWith) sketch.constraints.push(new SmoothConstraint(anchorPt.id, cont.smoothWith.id, handle.id));
    else if (cont.target) sketch.constraints.push(new CurveTangentConstraint(anchorPt.id, handle.id, cont.target));
  }

  /** Smooth clicks: the previous segment's arriving handle lines up with
   *  the cursor (where the next point goes), live. */
  _followCursor() {
    const last = this.anchors[this.anchors.length - 1];
    const seg = this.segs[this.segs.length - 1];
    if (!last || !seg || !last.auto || !last.smooth || last.cont || !this.cursor) { this._restoreAutoPrev(true); return; }
    const before = this.anchors[this.anchors.length - 2]?.pt;
    if (!before) return;
    const B = last.pt;
    const dir = unit(sub(this.cursor, before));
    if (!dir) return;
    if (!this._autoPrev) this._autoPrev = { pt: seg.c2, x: seg.c2.x, y: seg.c2.y };
    const h = this._hlen(before, B);
    seg.c2.x = B.x - dir.x * h; seg.c2.y = B.y - dir.y * h;
    last.inDir = dir;
  }
  /** Put the previous handle back (cursor left / path ended without a new point). */
  _restoreAutoPrev(restore) {
    if (this._autoPrev && restore) { this._autoPrev.pt.x = this._autoPrev.x; this._autoPrev.pt.y = this._autoPrev.y; }
    this._autoPrev = null;
  }

  /** Ends the path (keeps what's drawn). */
  finish() {
    this._restoreAutoPrev(true);
    this.anchors = [];
    this.segs = [];
    this.press = null;
    this._hint();
    this.app.requestRender();
  }

  /* ---- preview ---- */

  getPreview() {
    const last = this.anchors[this.anchors.length - 1];
    const out = { curves: [], handles: [], points: [], dashed: this.app.constructionMode };
    const pr = this.press;
    const target = pr ? pr.raw : this.cursor;
    if (pr?.drag) {                                   // handle being pulled
      const a = pr.raw, v = pr.drag.vec;
      out.handles.push({ anchor: a, handle: add(a, v) }, { anchor: a, handle: sub(a, v) });
    }
    if (last && target) {
      const A = last.pt, B = target;
      const h = this._hlen(A, B);
      const c1 = last.out ? add(A, last.out)
        : last.cont && this.segs.length === 0 ? add(A, mul(last.cont.dir, h))
          : last.smooth && last.inDir ? add(A, mul(last.inDir, h))
            : add(A, mul(sub(B, A), 1 / 3));
      let c2;
      if (pr?.drag) c2 = sub(B, pr.drag.vec);
      else {
        const snapPoint = (pr ? pr.snap : this.cursorSnap)?.kind === 'endpoint' ? (pr ? pr.snap : this.cursorSnap).entity : null;
        const cont = this._continuation(snapPoint instanceof Point ? snapPoint : null);
        c2 = cont ? add(B, mul(cont.dir, h)) : add(B, mul(sub(A, B), 1 / 3));
      }
      out.curves.push([A, c1, c2, B]);
      if (last.out || last.smooth) out.handles.push({ anchor: A, handle: c1 });
    }
    if (!last && target && !pr) return null;
    return out.curves.length || out.handles.length ? out : null;
  }
}

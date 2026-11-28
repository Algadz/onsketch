import { Arc, Point, newId } from '../core/entities.js';
import { markTangentContacts } from '../core/constraints.js';
import { pointFreedom, traceLocus } from '../core/locus.js';
import { simplifyPoints } from '../core/strokes.js';
import { pathComponent, pathFingerprint, untraceableMessage } from '../core/trace.js';

/* =============== TRACE PATH OF A POINT (as ink) ================
   Right-click a point → "Trace path": every position the point can take
   while the rest of the sketch moves as a mechanism (core/locus.js) is
   drawn as an ink stroke on the active layer: the current colour and pen
   size, dashed. It is ink like any other: select, restyle, group, erase,
   copy; never solved, dimensioned or snapped to.

   The stroke remembers its point (`traces`) and follows the sketch: when
   a change may make it wrong, it is traced again, as part of the same
   change (one undo step). If it can't be (its point deleted, fixed, or
   free in two directions), it keeps its drawing and shows as out of date
   (faded, with a ↻ mark), with why in Properties. While a value is
   dragged (scrubbing in the Equations window), paths follow live with a
   quick, coarser trace, redone at full quality when the value is set. Recompute is still
   offered (Properties, its right-click menu) to force a fresh trace.

     stroke.traces = { point: id, fp: fingerprint, tol, closed, ends }

   Out of date when what defines the mechanism changes (lengths, angles,
   relations, fixed points: not positions it can move through), or when
   the point is no longer on the drawn path (within `tol`).

   Only the shapes tied to the point through constraints take part, so a
   trace stays quick in a big sketch. The geometry is always put back.
   ============================================================ */

const TIME_LIMIT = 4000;        // ms for one trace asked for
const AUTO_TIME_LIMIT = 1500;   // ms for one automatic update
const LIVE_TIME_LIMIT = 120;    // ms for one update while a value is dragged

export class LocusMixin {
  /** Shapes linked to `point` through constraints (the mechanism that
   *  moves it), and the constraints among them. */
  _pathComponent(point) {
    const sketch = this.activeSketch(); if (!sketch) return null;
    return pathComponent(this.project, sketch, point);
  }

  /** The constraint system that moves `point`, for core/locus.js. */
  _pathSystem(point) {
    const comp = this._pathComponent(point); if (!comp) return null;
    this.project.syncLocks?.();
    const rows = [];
    const walk = (e, seen) => {
      if (seen.has(e)) return; seen.add(e);
      for (const c of e.children()) walk(c, seen);
      if (e.locked) return;
      for (const key of e.paramKeys()) rows.push({ ent: e, id: e.id, key, value: e[key] });
    };
    const seen = new Set();
    for (const e of comp.entities) walk(e, seen);
    const L = this._lookupFn(this.project.sketches);
    markTangentContacts(comp.constraints, L);
    const arcs = comp.entities.filter(e => e instanceof Arc);
    const sync = () => { for (const a of arcs) a.syncEnds(); };
    return {
      rows,
      sys: {
        n: rows.length,
        get: () => this._captureParamValues(rows),
        set: (v) => { this._applyParamValues(rows, v); sync(); },
        jacobian: () => this._constraintSystem(rows, comp.constraints, L),
        project: () => { const r = this._projectConstraintResidual(rows, comp.constraints, 8, L).residual; sync(); return r; },
        point: () => ({ x: point.x, y: point.y }),
      },
      comp,
    };
  }

  /** How many ways `point` can move with the sketch as a mechanism (0, 1, 2). */
  pointPathFreedom(point) {
    const s = this._pathSystem(point); if (!s || !s.rows.length) return 0;
    const v0 = s.sys.get();
    const f = pointFreedom(s.sys, s.sys.jacobian().J);
    s.sys.set(v0);
    return f.dof;
  }

  /** Size of the sketch: a first step and the box an endless path stops at. */
  _pathScale(point) {
    const sketch = this.activeSketch();
    let x0 = point.x, y0 = point.y, x1 = point.x, y1 = point.y;
    for (const e of sketch.entities) for (const p of [e, ...e.children()]) {
      if (p instanceof Point) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      if (e.r > 0 && p === e) { x0 = Math.min(x0, e.center.x - e.r); x1 = Math.max(x1, e.center.x + e.r); y0 = Math.min(y0, e.center.y - e.r); y1 = Math.max(y1, e.center.y + e.r); }
    }
    const size = Math.max(x1 - x0, y1 - y0, 1e-6 * Math.max(1, Math.abs(point.x) + Math.abs(point.y)), 10 / this.view.zoom);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return { size, bounds: { minX: cx - size, maxX: cx + size, minY: cy - size, maxY: cy + size } };
  }

  /** Traces the path of `point`. @returns {{ok, message, result?}} */
  _tracePath(point, timeLimit = TIME_LIMIT, coarse = false) {
    const s = this._pathSystem(point);
    if (!s || !s.rows.length) return { ok: false, message: 'This point is fixed: it has no path to trace.' };
    const { size, bounds } = this._pathScale(point);
    const before = s.sys.get();
    let result;
    try {
      result = coarse
        ? traceLocus(s.sys, { step: size / 70, maxStep: size / 18, bounds, timeLimit, maxTurn: Math.PI / 6 })
        : traceLocus(s.sys, { step: size / 160, maxStep: size / 40, bounds, timeLimit });
    } finally {
      s.sys.set(before);
      this._restoreSketchParams(s.rows);
    }
    if (!result.ok) {
      return { ok: false, message: untraceableMessage(result.dof) };
    }
    const pts = simplifyPoints(result.points, size * 2e-4);
    return { ok: true, result, points: pts.map(p => ({ x: p.x, y: p.y })), fp: this._pathFingerprint(point, s.comp), tol: size * 2e-3 };
  }

  /** Right-click a point → "Trace path". Adds the path as ink (selected). */
  tracePointPath(point) {
    const sketch = this.activeSketch(); if (!sketch || !(point instanceof Point)) return null;
    const t = this._tracePath(point);
    const hint = document.getElementById('status-hint');
    if (!t.ok) { if (hint) hint.textContent = t.message; return null; }
    const s = this.inkSettings('pen');
    const stroke = {
      id: newId('k'), layerId: this.project.activeLayerId, kind: 'pen',
      color: this.pen.fillColor, opacity: 1, width: s.size, dash: true,
      points: t.points,
      traces: { point: point.id, fp: t.fp, tol: t.tol, closed: t.result.closed, ends: t.result.ends },
    };
    this.clearSelection();
    this.clearStrokeSelection();
    sketch.strokes.push(stroke);
    stroke.selected = true;
    this.commit();
    this.refreshUI();
    this.requestRender();
    if (hint) hint.textContent = this._pathSummary(stroke.traces) + ' Drawn as ink: restyle or erase it like a stroke; it follows the sketch as it changes.';
    return stroke;
  }

  /** Redraws a traced path from its point's current mechanism. */
  recomputePointPath(stroke) {
    const hint = document.getElementById('status-hint');
    const point = this._lookupAny(stroke?.traces?.point);
    if (!(point instanceof Point)) { if (hint) hint.textContent = 'The point this path traces is gone: the drawing stays as it was.'; return false; }
    const t = this._tracePath(point);
    if (!t.ok) { if (hint) hint.textContent = t.message + ' The old path is kept.'; return false; }
    stroke.points = t.points;
    stroke.traces = { ...stroke.traces, fp: t.fp, tol: t.tol, closed: t.result.closed, ends: t.result.ends };
    delete stroke.link;
    stroke._stale = false;
    this._pathStaleKey = null;
    this.commit();
    this.refreshUI();
    this.requestRender();
    if (hint) hint.textContent = 'Path recomputed. ' + this._pathSummary(stroke.traces);
    return true;
  }

  _pathSummary(tr) {
    if (tr.closed) return 'Closed path: the point comes back round.';
    const why = { locked: 'where the mechanism locks', bounds: 'at twice the sketch\'s size (it goes on)', limit: 'at the length limit', free: 'where it gets free in two directions' };
    const ends = (tr.ends || []).map(e => why[e] || e);
    return ends.length === 2 && ends[0] === ends[1] ? `Open path: both ends stop ${ends[0]}.` : `Open path: it stops ${ends.join(' and ')}.`;
  }

  /** A short hash of what defines the point's mechanism: its shapes, the
   *  relations and dimensions among them (values, equations, fixed
   *  positions), and where held geometry sits. Positions the mechanism can
   *  move through are left out: dragging along the path doesn't change it. */
  _pathFingerprint(point, comp = this._pathComponent(point)) {
    return pathFingerprint(point, comp);
  }

  /** Distance from `p` to the drawn path (its points as a polyline). */
  _distanceToPath(stroke, p) {
    const pts = stroke.points;
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const A = pts[i], B = pts[i + 1] || A;
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
      const t = L2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2));
      best = Math.min(best, Math.hypot(p.x - A.x - t * dx, p.y - A.y - t * dy));
    }
    return best;
  }

  /** Out of date: what defines the mechanism changed, or the point is no
   *  longer on the drawn path (flipped to its other assembly, or the
   *  stroke was moved). */
  _pathIsStale(stroke) {
    const p = this._lookupAny(stroke.traces.point);
    if (!(p instanceof Point)) return true;
    if (this._pathFingerprint(p) !== stroke.traces.fp) return true;
    const tol = stroke.traces.tol > 0 ? stroke.traces.tol : 1e-3;
    return this._distanceToPath(stroke, p) > tol;
  }

  /** Re-traces, in place, every path that may no longer be right (no
   *  undo step of its own: commit() calls it before taking the snapshot,
   *  so the change and its updated paths are one step). A path that can't
   *  be traced any more (its point deleted, fixed, or free in two
   *  directions) keeps its drawing and shows as out of date, with why. */
  _autoUpdatePaths({ live = false } = {}) {
    const sketch = this.activeSketch(); if (!sketch) return false;
    const traced = sketch.strokes.filter(s => s.traces);
    let changed = false;
    for (const s of traced) {
      // a quick, coarser trace drawn while a value was dragged is redone
      // properly once the value is set
      if (!(s._coarse && !live) && !this._pathIsStale(s)) { s._stale = false; s._pathError = null; continue; }
      const point = this._lookupAny(s.traces.point);
      const t = point instanceof Point ? this._tracePath(point, live ? LIVE_TIME_LIMIT : AUTO_TIME_LIMIT, live) : { ok: false, message: 'Its point was deleted.' };
      if (!t.ok) { s._stale = true; s._pathError = t.message; continue; }
      s.points = t.points;
      s.traces = { ...s.traces, fp: t.fp, tol: t.tol * (live ? 4 : 1), closed: t.result.closed, ends: t.result.ends };
      delete s.link;
      s._stale = false; s._pathError = null;
      if (live) s._coarse = true; else delete s._coarse;
      changed = true;
    }
    return changed;
  }

  /** Keeps traced paths up to date for states that weren't committed
   *  here (a file opened, undo, redo): once per state, before drawing. */
  _markStalePaths() {
    const sketch = this.activeSketch(); if (!sketch) return;
    if (!sketch.strokes.some(s => s.traces)) return;
    const key = `${this.undoStack.length}:${this.redoStack.length}:${this.undoStack[this.undoStack.length - 1]?.length || 0}`;
    if (key === this._pathStaleKey) return;
    this._pathStaleKey = key;
    this._autoUpdatePaths();
  }

  /** "Trace path" for the point under the cursor (right-click menu). */
  pointPathActions(items) {
    const p = items.find(e => e instanceof Point && e.selected) || items.find(e => e instanceof Point);
    if (!p) return [];
    return [{ id: 'trace-path', glyph: '〰', label: 'Trace path of this point', hint: 'as ink', run: () => this.tracePointPath(p) }];
  }
}

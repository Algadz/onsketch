import { Arc, Point, newId } from '../core/entities.js';
import { markTangentContacts } from '../core/constraints.js';
import { pointFreedom, traceLocus } from '../core/locus.js';
import { simplifyPoints } from '../core/strokes.js';

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
    const byId = this._lookupMap(this.project.sketches);
    const ownerOf = (id) => { const e = byId.get(id); return e ? (this.project.ownerOf(e) || e) : null; };
    const ids = (e) => [e.id, ...(e.children ? e.children().map(c => c.id) : [])];
    const start = this.project.ownerOf(point) || point;
    const ents = new Set([start]), seen = new Set(), cons = new Set();
    const byRef = new Map();
    for (const c of sketch.constraints) {
      if (c.driven) continue;
      for (const id of c.refs()) { if (!byRef.has(id)) byRef.set(id, []); byRef.get(id).push(c); }
    }
    const queue = [start];
    while (queue.length) {
      const e = queue.pop();
      for (const id of ids(e)) {
        if (seen.has(id)) continue;
        seen.add(id);
        for (const c of byRef.get(id) || []) {
          if (cons.has(c)) continue;
          cons.add(c);
          for (const r of c.refs()) {
            const o = ownerOf(r);
            if (o && !ents.has(o)) { ents.add(o); queue.push(o); }
          }
        }
      }
    }
    return { entities: [...ents], constraints: [...cons] };
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
      return { ok: false, message: result.dof === 0
        ? 'This point can\'t move: the sketch holds it in place, so its path is just the point.'
        : 'This point can move freely in two directions, so its positions cover an area, not a path. Add a constraint or fix a point of the mechanism, then trace again.' };
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
    if (!comp) return '';
    let h = 2166136261;
    const mix = (s) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); };
    const num = (v) => mix(Number.isFinite(v) ? String(Number(v.toPrecision(7))) : String(v));
    const ents = [...comp.entities].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const e of ents) for (const x of [e, ...e.children()]) {
      mix(x.id);
      if (x.locked) { mix('L'); for (const k of x.paramKeys()) num(x[k]); }   // held: its place matters
    }
    const cons = [...comp.constraints].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const c of cons) {
      const o = c.toJSON ? c.toJSON() : { kind: c.kind };
      for (const k of Object.keys(o).sort()) {
        if (/^label|^layerId$|^name$/.test(k)) continue;           // where a label sits, what it's called
        const v = o[k];
        mix(k);
        if (typeof v === 'number') num(v); else mix(JSON.stringify(v));
      }
    }
    return 'v2:' + (h >>> 0).toString(36) + ':' + cons.length;
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

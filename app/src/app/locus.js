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

   The stroke remembers its point (`traces`), so it can be recomputed on
   demand (Properties, its right-click menu). When the shapes it depends
   on change, it shows as out of date (faded, with a ↻ mark) until then.

     stroke.traces = { point: id, fp: fingerprint, closed, ends }

   Only the shapes tied to the point through constraints take part, so a
   trace stays quick in a big sketch. The geometry is always put back.
   ============================================================ */

const TIME_LIMIT = 4000;        // ms for one trace

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
  _tracePath(point) {
    const s = this._pathSystem(point);
    if (!s || !s.rows.length) return { ok: false, message: 'This point is fixed: it has no path to trace.' };
    const { size, bounds } = this._pathScale(point);
    const before = s.sys.get();
    let result;
    try {
      result = traceLocus(s.sys, { step: size / 160, maxStep: size / 40, bounds, timeLimit: TIME_LIMIT });
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
    return { ok: true, result, points: pts.map(p => ({ x: p.x, y: p.y })), fp: this._pathFingerprint(point, s.comp) };
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
      traces: { point: point.id, fp: t.fp, closed: t.result.closed, ends: t.result.ends },
    };
    this.clearSelection();
    this.clearStrokeSelection();
    sketch.strokes.push(stroke);
    stroke.selected = true;
    this.commit();
    this.refreshUI();
    this.requestRender();
    if (hint) hint.textContent = this._pathSummary(stroke.traces) + ' Drawn as ink: restyle or erase it like a stroke; Recompute it from Properties after changing the sketch.';
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
    stroke.traces = { ...stroke.traces, fp: t.fp, closed: t.result.closed, ends: t.result.ends };
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

  /** A short hash of everything the point's path depends on. */
  _pathFingerprint(point, comp = this._pathComponent(point)) {
    if (!comp) return '';
    let h = 2166136261;
    const mix = (s) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); };
    const num = (v) => mix(Number.isFinite(v) ? v.toFixed(6) : String(v));
    for (const e of comp.entities) for (const x of [e, ...e.children()]) {
      mix(x.id); for (const k of x.paramKeys()) num(x[k]);
      if (x.fixed) mix('F'); if (x.locked) mix('L');
    }
    for (const c of comp.constraints) { mix(c.kind + c.id); if (c.value != null) num(c.value); if (c.expr) mix(c.expr); }
    return (h >>> 0).toString(36) + ':' + comp.constraints.length;
  }

  /** Marks traced paths whose shapes changed (`_stale`, not saved).
   *  Checked once per committed state, not on every frame. */
  _markStalePaths() {
    const sketch = this.activeSketch(); if (!sketch) return;
    const traced = sketch.strokes.filter(s => s.traces);
    if (!traced.length) return;
    const key = `${this.undoStack.length}:${this.redoStack.length}:${this.undoStack[this.undoStack.length - 1]?.length || 0}`;
    if (key === this._pathStaleKey) return;
    this._pathStaleKey = key;
    for (const s of traced) {
      const p = this._lookupAny(s.traces.point);
      s._stale = !(p instanceof Point) || this._pathFingerprint(p) !== s.traces.fp;
    }
  }

  /** "Trace path" for the point under the cursor (right-click menu). */
  pointPathActions(items) {
    const p = items.find(e => e instanceof Point && e.selected) || items.find(e => e instanceof Point);
    if (!p) return [];
    return [{ id: 'trace-path', glyph: '〰', label: 'Trace path of this point', hint: 'as ink', run: () => this.tracePointPath(p) }];
  }
}

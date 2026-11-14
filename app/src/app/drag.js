import { EPS, TAU, clamp, directedArcSpan, dist, nullSpaceBasis, rowSpaceBasis, solveLeastSquares, unwrapAngleNear } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { DistanceConstraint, FixConstraint, ParamFixConstraint } from '../core/constraints.js';
import { sameLineRefs } from '../editor/relations.js';

export class DragMixin {

  /** Movable parameters of the sketch. Locked geometry is left out, so
   *  every drag / solve path built on these rows treats it as constant. */
  _captureSketchParams(sketch) {
    if (sketch.project) sketch.project.syncLocks();
    const rows = [];
    const seen = new Set();
    const walk = (e) => {
      if (seen.has(e)) return;
      seen.add(e);
      for (const c of e.children()) walk(c);
      if (e.locked) return;
      for (const key of e.paramKeys()) rows.push({ ent:e, id:e.id, key, value:e[key] });
    };
    for (const e of sketch.entities) walk(e);
    return rows;
  }

  _restoreSketchParams(rows) {
    for (const r of rows) r.ent[r.key] = r.value;
  }

  _paramIndexMap(rows) {
    const map = new Map();
    for (let i = 0; i < rows.length; i++) map.set(rows[i].id + ':' + rows[i].key, i);
    return map;
  }

  _captureParamValues(rows) {
    return rows.map(r => r.ent[r.key]);
  }

  _applyParamValues(rows, values) {
    for (let i = 0; i < rows.length; i++) rows[i].ent[rows[i].key] = values[i];
  }

  _offsetGeometryValid(sketch) {
    if (!sketch) return true;
    const L = (id, key) => {
      const e = this._lookupAny(id);
      return e ? e[key] : 0;
    };
    for (const c of sketch.constraints) {
      if (c.driven) continue;
      if (c.kind === 'offset' && c.offsetKind === 'line') {
        const dx1=L(c.l1.b,'x')-L(c.l1.a,'x'), dy1=L(c.l1.b,'y')-L(c.l1.a,'y');
        const dx2=L(c.l2.b,'x')-L(c.l2.a,'x'), dy2=L(c.l2.b,'y')-L(c.l2.a,'y');
        if (Math.hypot(dx1, dy1) <= EPS || Math.hypot(dx2, dy2) <= EPS) return false;
        if (dx1 * dx2 + dy1 * dy2 <= EPS) return false;
      } else if (c.kind === 'offset' && c.offsetKind === 'circle') {
        const source = this._lookupAny(c.sourceEntityId);
        const target = this._lookupAny(c.targetEntityId);
        if ((source instanceof Circle || source instanceof Arc) && source.r <= EPS) return false;
        if ((target instanceof Circle || target instanceof Arc) && target.r <= EPS) return false;
      } else if (c.kind === 'offsetDistance' && c.pairs) {
        for (const p of c.pairs) {
          if (p.value == null || Math.abs(p.value) <= EPS) continue;
          if (p.kind === 'line') {
            const px=L(p.pointId,'x'), py=L(p.pointId,'y');
            const ax=L(p.l.a,'x'), ay=L(p.l.a,'y'), bx=L(p.l.b,'x'), by=L(p.l.b,'y');
            const dx=bx-ax, dy=by-ay;
            const len = Math.hypot(dx, dy);
            if (len <= EPS) return false;
            const signed = (dx*(py-ay) - dy*(px-ax)) / len;
            if (signed * p.value <= EPS) return false;
          } else if (p.kind === 'circle') {
            const radial = L(p.c1,'r') - L(p.c2,'r');
            if (radial * p.value <= EPS) return false;
          }
        }
      }
    }
    return true;
  }

  _lineLengthById(id) {
    const e = this._lookupAny(id);
    return e instanceof Line ? dist(e.p1, e.p2) : null;
  }

  _curveRadiusById(id) {
    const e = this._lookupAny(id);
    return (e instanceof Circle || e instanceof Arc) ? e.r : null;
  }

  _minOffsetDragSize(size) {
    const zoom = this.view?.zoom || 4;
    const visualFloor = 4 / zoom;
    return Math.max(EPS, Math.min(size * 0.1, visualFloor));
  }

  _signedAreaForPointIds(pointIds) {
    if (!pointIds || pointIds.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < pointIds.length; i++) {
      const a = this._lookupAny(pointIds[i]);
      const b = this._lookupAny(pointIds[(i + 1) % pointIds.length]);
      if (!a || !b) return 0;
      area += a.x * b.y - b.x * a.y;
    }
    return area / 2;
  }

  _closedLineLoopsFromEntityIds(entityIds) {
    const lines = [];
    for (const id of entityIds || []) {
      const e = this._lookupAny(id);
      if (e instanceof Line) lines.push(e);
    }
    if (lines.length < 3) return [];

    const byPoint = new Map();
    const lineById = new Map();
    const addAtPoint = (p, line) => {
      if (!byPoint.has(p.id)) byPoint.set(p.id, []);
      byPoint.get(p.id).push(line);
    };
    for (const line of lines) {
      lineById.set(line.id, line);
      addAtPoint(line.p1, line);
      addAtPoint(line.p2, line);
    }

    const unvisited = new Set(lines.map(l => l.id));
    const loops = [];
    while (unvisited.size) {
      const seedId = unvisited.values().next().value;
      const componentIds = new Set();
      const stack = [lineById.get(seedId)];
      while (stack.length) {
        const line = stack.pop();
        if (!line || componentIds.has(line.id)) continue;
        componentIds.add(line.id);
        unvisited.delete(line.id);
        for (const p of [line.p1, line.p2]) {
          for (const next of byPoint.get(p.id) || []) {
            if (!componentIds.has(next.id)) stack.push(next);
          }
        }
      }
      if (componentIds.size < 3) continue;

      const componentPoints = new Set();
      for (const id of componentIds) {
        const line = lineById.get(id);
        componentPoints.add(line.p1.id);
        componentPoints.add(line.p2.id);
      }
      let closed = true;
      for (const pointId of componentPoints) {
        const degree = (byPoint.get(pointId) || []).filter(l => componentIds.has(l.id)).length;
        if (degree !== 2) { closed = false; break; }
      }
      if (!closed) continue;

      const first = lineById.get(componentIds.values().next().value);
      const startId = first.p1.id;
      let currentId = first.p2.id;
      let previousLineId = first.id;
      const used = new Set([first.id]);
      const pointIds = [first.p1.id, first.p2.id];
      let ok = true;
      while (currentId !== startId) {
        const candidates = (byPoint.get(currentId) || [])
          .filter(l => componentIds.has(l.id) && l.id !== previousLineId && !used.has(l.id));
        if (candidates.length !== 1) { ok = false; break; }
        const next = candidates[0];
        used.add(next.id);
        const nextPoint = next.p1.id === currentId ? next.p2 : next.p1;
        pointIds.push(nextPoint.id);
        previousLineId = next.id;
        currentId = nextPoint.id;
        if (used.size > componentIds.size) { ok = false; break; }
      }
      if (!ok || used.size !== componentIds.size) continue;
      if (pointIds[pointIds.length - 1] === startId) pointIds.pop();
      loops.push({ pointIds });
    }
    return loops;
  }

  _offsetFeatureTouchesIds(feature, seedIds) {
    if (!seedIds || !seedIds.size) return true;
    const ids = []
      .concat(feature.sourceEntityIds || [])
      .concat(feature.generatedEntityIds || []);
    for (const id of ids) {
      if (seedIds.has(id)) return true;
      const e = this._lookupAny(id);
      if (!e || !e.children) continue;
      for (const child of e.children()) {
        if (seedIds.has(child.id)) return true;
      }
    }
    return false;
  }

  _captureOffsetDragGuard(sketch, seedIds = null) {
    const guard = { lines: [], curves: [] };
    if (!sketch) return guard;
    const seedSet = seedIds ? new Set(seedIds) : null;
    const features = sketch.features || [];
    for (const feature of features) {
      if (feature.kind !== 'offset') continue;
      if (!this._offsetFeatureTouchesIds(feature, seedSet)) continue;
      for (const ids of [feature.sourceEntityIds || [], feature.generatedEntityIds || []]) {
        for (const id of ids) {
          const len = this._lineLengthById(id);
          if (len != null && len > EPS) {
            guard.lines.push({ id, minLength:this._minOffsetDragSize(len) });
          }
          const radius = this._curveRadiusById(id);
          if (radius != null && radius > EPS) {
            guard.curves.push({ id, minRadius:this._minOffsetDragSize(radius) });
          }
        }
      }
    }
    return guard;
  }

  _offsetDragGuardValid(guard) {
    if (!guard) return true;
    for (const item of guard.lines || []) {
      const len = this._lineLengthById(item.id);
      if (len == null) continue;
      if (len <= item.minLength) return false;
    }
    for (const item of guard.curves || []) {
      const radius = this._curveRadiusById(item.id);
      if (radius == null) continue;
      if (radius <= item.minRadius) return false;
    }
    return true;
  }

  _finishDragStep(drag, result) {
    const sketch = this.activeSketch();
    if (!sketch) return result;
    if (sketch && (!this._offsetGeometryValid(sketch) || !this._offsetDragGuardValid(drag?.offsetGuard))) {
      if (drag?.lastValidValues) this._applyParamValues(drag.state, drag.lastValidValues);
      else if (drag?.state) this._restoreSketchParams(drag.state);
      for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
      return { ...(result || {}), ok:false, rejected:true, state:this._lastSolve?.state || 'under' };
    }
    if (drag?.state) drag.lastValidValues = this._captureParamValues(drag.state);
    for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
    return result;
  }

  _setOffsetDistanceValue(c, value) {
    const mag = Math.abs(value);
    c.value = mag;
    if (!c.pairs) return;
    const L = (id, key) => {
      const e = this._lookupAny(id);
      return e ? e[key] : 0;
    };
    for (const p of c.pairs) {
      let sign = p.value != null && p.value < 0 ? -1 : 1;
      if (p.value == null) {
        if (p.kind === 'line') {
          const px=L(p.pointId,'x'), py=L(p.pointId,'y');
          const ax=L(p.l.a,'x'), ay=L(p.l.a,'y'), bx=L(p.l.b,'x'), by=L(p.l.b,'y');
          const dx=bx-ax, dy=by-ay;
          const len = Math.hypot(dx, dy);
          if (len > EPS) sign = (dx*(py-ay) - dy*(px-ax)) < 0 ? -1 : 1;
        } else if (p.kind === 'circle') {
          sign = (L(p.c1,'r') - L(p.c2,'r')) < 0 ? -1 : 1;
        }
      }
      p.value = sign * mag;
    }
  }

  _ensureOffsetPairSigns(sketch) {
    if (!sketch) return;
    for (const c of sketch.constraints) {
      if (c.kind !== 'offsetDistance' || !c.pairs) continue;
      this._setOffsetDistanceValue(c, c.value);
    }
  }

  _offsetLinkedSnapIgnoreIds(sketch, seedIds) {
    const ignore = new Set(seedIds || []);
    // A pattern moves as one: its seed and copies never snap to each other.
    for (const c of sketch.constraints) {
      if (c.kind !== 'pattern') continue;
      const members = c.memberIds();
      if ([...ignore].some(id => members.has(id))) for (const id of members) ignore.add(id);
    }
    let touchesOffset = false;
    for (const c of sketch.constraints) {
      if (c.kind === 'offset' && c.refs().some(id => ignore.has(id))) {
        touchesOffset = true;
        break;
      }
    }
    if (!touchesOffset) return ignore;

    const addEntity = (id) => {
      if (!id) return;
      ignore.add(id);
      const e = this._lookupAny(id);
      if (e && e.children) {
        for (const child of e.children()) ignore.add(child.id);
      }
    };
    const addMany = (ids) => ids.forEach(addEntity);
    let changed = true;
    while (changed) {
      changed = false;
      const before = ignore.size;
      for (const c of sketch.constraints) {
        if (c.kind === 'offset') {
          const sourceRefs = c.offsetKind === 'line'
            ? [c.sourceEntityId, c.l1.a, c.l1.b]
            : [c.sourceEntityId, c.p1];
          const targetRefs = c.offsetKind === 'line'
            ? [c.targetEntityId, c.l2.a, c.l2.b]
            : [c.targetEntityId, c.p2];
          if (sourceRefs.some(id => ignore.has(id)) || targetRefs.some(id => ignore.has(id))) {
            addMany(sourceRefs);
            addMany(targetRefs);
          }
        }
      }
      changed = ignore.size !== before;
    }
    return ignore;
  }

  _dragJointConstraintKinds() {
    return new Set(['coincident', 'arcEndpointCoincident', 'arcEndpointArcEndpointCoincident']);
  }

  _buildConstraintGraph(sketch, options = {}) {
    const skipKinds = options.skipKinds || null;
    const graph = new Map();
    const add = (id) => {
      if (!id) return;
      if (!graph.has(id)) graph.set(id, new Set());
    };
    const link = (a, b) => {
      if (!a || !b || a === b) return;
      add(a); add(b);
      graph.get(a).add(b);
      graph.get(b).add(a);
    };
    for (const e of sketch.entities) {
      add(e.id);
      for (const c of e.children()) {
        add(c.id);
        link(e.id, c.id);
      }
    }
    for (const c of sketch.constraints) {
      const refs = c.refs().filter(Boolean);
      for (const id of refs) add(id);
      if (skipKinds && skipKinds.has(c.kind)) continue;
      if (c.graphLinks) { for (const [a, b] of c.graphLinks()) link(a, b); continue; }
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) link(refs[i], refs[j]);
      }
    }
    return graph;
  }

  _buildSolvingGraph(sketch) {
    const graph = new Map();
    const add = (id) => {
      if (!id) return;
      if (!graph.has(id)) graph.set(id, new Set());
    };
    const link = (a, b) => {
      if (!a || !b || a === b) return;
      add(a); add(b);
      graph.get(a).add(b);
      graph.get(b).add(a);
    };
    for (const e of sketch.entities) {
      add(e.id);
      for (const c of e.children()) add(c.id);
    }
    for (const c of sketch.constraints) {
      if (c.driven) continue;
      const refs = c.refs().filter(Boolean);
      for (const id of refs) add(id);
      if (c.graphLinks) { for (const [a, b] of c.graphLinks()) link(a, b); continue; }
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) link(refs[i], refs[j]);
      }
    }
    return graph;
  }

  _graphDistances(graph, startIds) {
    const distMap = new Map();
    const q = [];
    for (const id of startIds) {
      distMap.set(id, 0);
      q.push(id);
      if (!graph.has(id)) graph.set(id, new Set());
    }
    for (let qi = 0; qi < q.length; qi++) {
      const id = q[qi];
      const d = distMap.get(id);
      for (const nb of (graph.get(id) || [])) {
        if (distMap.has(nb)) continue;
        distMap.set(nb, d + 1);
        q.push(nb);
      }
    }
    return distMap;
  }

  _componentFrom(graph, startId) {
    const component = new Set();
    const q = [startId];
    component.add(startId);
    for (let qi = 0; qi < q.length; qi++) {
      const id = q[qi];
      for (const nb of (graph.get(id) || [])) {
        if (component.has(nb)) continue;
        component.add(nb);
        q.push(nb);
      }
    }
    return component;
  }

  _activeIdsAndPoints(sketch) {
    const ids = new Set();
    const points = new Map();
    const walk = (e) => {
      ids.add(e.id);
      if (e instanceof Point) points.set(e.id, e);
      for (const c of e.children()) walk(c);
    };
    for (const e of sketch.entities) walk(e);
    return { ids, points };
  }

  _componentIsAnchored(sketch, component, activeIds, pointById) {
    for (const id of component) {
      if (!activeIds.has(id)) return true;
      const p = pointById.get(id);
      if (p && (p.fixed || p.locked)) return true;
    }
    for (const c of sketch.constraints) {
      if (c.kind === 'fix' && component.has(c.pointId)) return true;
    }
    return false;
  }

  _componentHasExternalJoint(sketch, component, jointKinds = this._dragJointConstraintKinds()) {
    for (const c of sketch.constraints) {
      if (!jointKinds.has(c.kind)) continue;
      const refs = c.refs().filter(Boolean);
      const inside = refs.some(id => component.has(id));
      const outside = refs.some(id => !component.has(id));
      if (inside && outside) return true;
    }
    return false;
  }

  _componentAnchorPoint(sketch, component, activeIds, pointById) {
    const anchors = new Map();
    const addPoint = (p) => { if (p) anchors.set(p.id, p); };
    for (const id of component) {
      if (!activeIds.has(id)) {
        const e = this._lookupAny(id);
        if (e instanceof Point) addPoint(e);
        else return null;
      }
      const p = pointById.get(id);
      if (p && (p.fixed || p.locked)) addPoint(p);
    }
    for (const c of sketch.constraints) {
      if (c.kind === 'fix' && component.has(c.pointId)) addPoint(pointById.get(c.pointId) || this._lookupAny(c.pointId));
    }
    return anchors.size === 1 ? [...anchors.values()][0] : null;
  }

  _constraintResidualNorm(constraints, L = null) {
    L = L || this._lookupFn();
    let sum = 0;
    for (const c of constraints) {
      for (const r of c.residuals(L)) sum += r * r;
    }
    return Math.sqrt(sum);
  }

  _constraintSystem(rows, constraints, L = null) {
    const activeConstraints = constraints.filter(c => !c.driven);
    L = L || this._lookupFn();
    const computeF = () => {
      const f = [];
      for (const c of activeConstraints) for (const r of c.residuals(L)) f.push(r);
      return f;
    };
    const f = computeF();
    const m = f.length, n = rows.length;
    const J = Array.from({ length:m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const r = rows[j];
      const x0 = r.ent[r.key];
      const step = Math.max(1e-6, Math.abs(x0) * 1e-7);
      r.ent[r.key] = x0 + step;
      const fp = computeF();
      r.ent[r.key] = x0;
      const inv = 1 / step;
      for (let i = 0; i < m; i++) J[i][j] = (fp[i] - f[i]) * inv;
    }
    const residual = Math.sqrt(f.reduce((s, v) => s + v*v, 0));
    return { f, J, residual };
  }

  _applyParamStep(rows, step) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let v = r.ent[r.key] + step[i];
      if (r.key === 'r') v = Math.max(EPS, v);
      r.ent[r.key] = v;
    }
  }

  _projectConstraintResidual(rows, constraints, passes = 2, L = null) {
    L = L || this._lookupFn();
    for (let pass = 0; pass < passes; pass++) {
      const sys = this._constraintSystem(rows, constraints, L);
      if (sys.residual < 1e-7 || !sys.J.length) return sys;
      const step = solveLeastSquares(sys.J, sys.f.map(v => -v), 1e-6);
      if (!step) return sys;
      const before = this._captureParamValues(rows);
      this._applyParamStep(rows, step);
      const next = this._constraintSystem(rows, constraints, L);
      if (next.residual <= sys.residual) continue;
      this._applyParamValues(rows, before);
      return sys;
    }
    return this._constraintSystem(rows, constraints, L);
  }

  _makeDragIntent(startWorld, pts, hit, rows) {
    const index = this._paramIndexMap(rows);
    const targets = [];
    const pointCoeff = (p, key, coeff = 1) => {
      const idx = index.get(p.id + ':' + key);
      return idx == null ? null : { idx, coeff };
    };
    const addTarget = (coeffs, start, axis, weight) => {
      const clean = coeffs.filter(Boolean);
      if (clean.length) targets.push({ coeffs:clean, start, axis, weight });
    };
    const addPointTargets = (p, weight) => {
      addTarget([pointCoeff(p, 'x')], p.x, 'x', weight);
      addTarget([pointCoeff(p, 'y')], p.y, 'y', weight);
    };
    const addLineHandleTargets = (line, weight) => {
      const dx = line.p2.x - line.p1.x, dy = line.p2.y - line.p1.y;
      const len2 = dx*dx + dy*dy;
      const t = len2 > EPS
        ? clamp(((startWorld.x - line.p1.x)*dx + (startWorld.y - line.p1.y)*dy) / len2, 0, 1)
        : 0.5;
      const a = 1 - t, b = t;
      addTarget([pointCoeff(line.p1, 'x', a), pointCoeff(line.p2, 'x', b)], a*line.p1.x + b*line.p2.x, 'x', weight);
      addTarget([pointCoeff(line.p1, 'y', a), pointCoeff(line.p2, 'y', b)], a*line.p1.y + b*line.p2.y, 'y', weight);
    };

    if (hit instanceof Point) {
      addPointTargets(hit, 400);
    } else if (hit instanceof Line) {
      addLineHandleTargets(hit, 400);
    } else if (pts.length === 1) {
      addPointTargets(pts[0].p, 400);
    } else if (pts.length === 2) {
      const p1 = pts[0].p, p2 = pts[1].p;
      addLineHandleTargets({ p1, p2 }, 400);
    } else if (pts.length > 2) {
      const n = pts.length;
      const cx = pts.reduce((s, r) => s + r.x, 0) / n;
      const cy = pts.reduce((s, r) => s + r.y, 0) / n;
      addTarget(pts.map(r => pointCoeff(r.p, 'x', 1 / n)), cx, 'x', 400);
      addTarget(pts.map(r => pointCoeff(r.p, 'y', 1 / n)), cy, 'y', 400);
      for (const r of pts) addPointTargets(r.p, 0.5);
    }
    return targets.length ? { targets } : null;
  }

  _intentTargetValue(target, dx, dy) {
    return target.start + (target.axis === 'x' ? dx : dy);
  }

  _intentCurrentValue(target, rows) {
    let v = 0;
    for (const c of target.coeffs) v += c.coeff * rows[c.idx].ent[rows[c.idx].key];
    return v;
  }

  _dragParamRegularization(drag, row) {
    const d = drag.distances?.get(row.id);
    if (d === 0) return 0.01;
    if (d === 1) return 0.03;
    if (d === 2) return 0.08;
    if (Number.isFinite(d)) return 0.15 + d * 0.05;
    return 2.0;
  }

  _intentLeastSquares(drag, nullBasis, dx, dy) {
    const rows = drag.state;
    const A = [], b = [];
    for (const target of drag.intent.targets) {
      const row = nullBasis.map(v => target.coeffs.reduce((s, c) => s + c.coeff * v[c.idx], 0));
      const norm = Math.sqrt(row.reduce((s, v) => s + v*v, 0));
      if (norm < 1e-10) continue;
      const w = Math.sqrt(target.weight);
      A.push(row.map(v => v * w));
      b.push((this._intentTargetValue(target, dx, dy) - this._intentCurrentValue(target, rows)) * w);
    }
    for (let i = 0; i < rows.length; i++) {
      const w0 = this._dragParamRegularization(drag, rows[i]);
      if (w0 <= 0) continue;
      const w = Math.sqrt(w0);
      A.push(nullBasis.map(v => v[i] * w));
      b.push((rows[i].value - rows[i].ent[rows[i].key]) * w);
    }
    return { A, b };
  }

  _dragIntentError(drag, dx, dy) {
    let sum = 0, n = 0;
    for (const target of drag.intent.targets) {
      const e = this._intentTargetValue(target, dx, dy) - this._intentCurrentValue(target, drag.state);
      sum += e * e;
      n++;
    }
    return n ? Math.sqrt(sum / n) : 0;
  }

  _dragRigidLineConstraints(dragOrLocks) {
    const locks = Array.isArray(dragOrLocks) ? dragOrLocks : (dragOrLocks?.rigidLines || []);
    return locks.flatMap(l => {
      const length = Math.hypot(l.dx, l.dy);
      return [new DistanceConstraint(l.p1, l.p2, length)];
    });
  }

  _mirrorAxisSourceLocks(sketch, axisLine, draggedPointIds = new Set()) {
    if (!sketch || !(axisLine instanceof Line)) return [];
    const axisIds = new Set([axisLine.p1.id, axisLine.p2.id]);
    const dragged = draggedPointIds instanceof Set ? draggedPointIds : new Set(draggedPointIds || []);
    const symmetric = sketch.constraints.filter(c =>
      c.kind === 'symmetric' && sameLineRefs(axisLine, c.axis));
    if (!symmetric.length) return [];

    const hasSourceMetadata = symmetric.some(c => c.sourceSide === 'p1' || c.sourceSide === 'p2');
    const allowLegacyMirrorIntent = !hasSourceMetadata && symmetric.length > 1;
    const locks = [];
    const seen = new Set();
    for (const c of symmetric) {
      const side = c.sourceSide || (allowLegacyMirrorIntent ? 'p1' : null);
      if (side !== 'p1' && side !== 'p2') continue;
      const sourceId = side === 'p2' ? c.p2 : c.p1;
      if (!sourceId || axisIds.has(sourceId) || dragged.has(sourceId) || seen.has(sourceId)) continue;
      const p = this._lookupAny(sourceId);
      if (!(p instanceof Point)) continue;
      locks.push(new FixConstraint(p.id, p.x, p.y));
      seen.add(sourceId);
    }
    return locks;
  }

  _mirrorAxisSourceLocksForDrag(sketch, hit, draggedPointIds = new Set()) {
    if (!sketch) return [];
    const dragged = draggedPointIds instanceof Set ? draggedPointIds : new Set(draggedPointIds || []);
    const axes = [];
    const addAxis = (line) => {
      if (!(line instanceof Line)) return;
      if (!sketch.constraints.some(c => c.kind === 'symmetric' && sameLineRefs(line, c.axis))) return;
      if (!axes.includes(line)) axes.push(line);
    };
    if (hit instanceof Line) addAxis(hit);
    if (hit instanceof Point) {
      for (const e of sketch.entities) {
        if (e instanceof Line && (e.p1 === hit || e.p2 === hit || dragged.has(e.p1.id) || dragged.has(e.p2.id))) {
          addAxis(e);
        }
      }
    }
    const locks = [];
    const seen = new Set();
    for (const axis of axes) {
      for (const lock of this._mirrorAxisSourceLocks(sketch, axis, dragged)) {
        if (seen.has(lock.pointId)) continue;
        seen.add(lock.pointId);
        locks.push(lock);
      }
    }
    return locks;
  }

  _beginDofDrag(sketch, state, startWorld, pts, hit, distances, rigidLines = [], mirrorAxisLocks = []) {
    const componentIds = new Set(distances.keys());
    const localState = state.filter(r => componentIds.has(r.id));
    if (!localState.length) return null;
    const constraints = sketch.constraints
      .filter(c => !c.driven && c.refs().some(id => componentIds.has(id)))
      .concat(this._dragRigidLineConstraints(rigidLines), mirrorAxisLocks);
    const lookup = this._lookupFn(this.project.sketches);
    const sys = this._constraintSystem(localState, constraints, lookup);
    if (sys.residual > 1e-4) return null;
    const intent = this._makeDragIntent(startWorld, pts, hit, localState);
    if (!intent) return null;
    const rowBasis = rowSpaceBasis(sys.J, 1e-7);
    const nullBasis = nullSpaceBasis(rowBasis, localState.length, 1e-7);
    if (!nullBasis.length) {
      return {
        mode:'locked',
        startWorld,
        pts,
        snapPts:pts,
        state:localState,
        distances,
        rigidLines,
        mirrorAxisLocks,
        snapIgnoreIds:this._offsetLinkedSnapIgnoreIds(sketch, pts.map(r => r.p.id))
      };
    }
    let responsive = false;
    for (const target of intent.targets) {
      for (const v of nullBasis) {
        const projected = target.coeffs.reduce((s, c) => s + c.coeff * v[c.idx], 0);
        if (Math.abs(projected) > 1e-7) { responsive = true; break; }
      }
      if (responsive) break;
    }
    if (!responsive) return null;
    return {
      mode:'dof',
      startWorld,
      pts,
      snapPts:pts,
      state:localState,
      constraints,
      intent,
      distances,
      rigidLines,
      mirrorAxisLocks,
      lookup,
      // A DOF drag moves the selected handle through an existing constrained
      // component. Other points in that component are legitimate targets.
      snapIgnoreIds:this._offsetLinkedSnapIgnoreIds(sketch, pts.map(r => r.p.id))
    };
  }

  /** One drag frame for a point with freedom left (e.g. swinging on a
   *  fixed-length arm). The motion is searched from two starts: the
   *  geometry at drag start (path-independent) and the previous frame
   *  (short step, follows curved paths smoothly). The result closer to
   *  the cursor wins, so the handle can't hop to a far-off solution. */
  _solveDofDrag(drag, dx, dy) {
    const previous = this._captureParamValues(drag.state);
    this._restoreSketchParams(drag.state);
    const fromStart = this._dofDragFrom(drag, dx, dy);
    this._applyParamValues(drag.state, previous);
    const fromPrevious = this._dofDragFrom(drag, dx, dy);
    const best = fromPrevious.error <= fromStart.error ? fromPrevious : fromStart;

    this._applyParamValues(drag.state, best.values);
    const sys = this._constraintSystem(drag.state, drag.constraints, drag.lookup);
    const result = {
      ok: sys.residual < 1e-4,
      iters: best.iterations,
      residual: sys.residual,
      state: this._lastSolve?.state || 'under'
    };
    return this._finishDragStep(drag, result);
  }

  /** Iterate from the current parameter values toward the cursor intent,
   *  moving only along the constraints' free directions. Returns the best
   *  values found and their intent error (geometry left as found best). */
  _dofDragFrom(drag, dx, dy) {
    let bestValues = this._captureParamValues(drag.state);
    let bestError = this._dragIntentError(drag, dx, dy);
    let iterations = 0;
    for (let iter = 0; iter < 20; iter++) {
      iterations = iter + 1;
      const sys = this._constraintSystem(drag.state, drag.constraints, drag.lookup);
      const rowBasis = rowSpaceBasis(sys.J, 1e-7);
      const nullBasis = nullSpaceBasis(rowBasis, drag.state.length, 1e-7);
      if (!nullBasis.length) break;
      const { A, b } = this._intentLeastSquares(drag, nullBasis, dx, dy);
      if (!A.length) break;
      const z = solveLeastSquares(A, b, 1e-8);
      if (!z) break;
      const step = new Array(drag.state.length).fill(0);
      for (let k = 0; k < nullBasis.length; k++) {
        for (let i = 0; i < step.length; i++) step[i] += nullBasis[k][i] * z[k];
      }
      const maxStep = step.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      if (maxStep < 1e-7) break;
      // Backtracking: a long step along the free directions of a curved
      // path (an arm swinging round a pivot) leaves the constraints badly
      // broken. Try shorter steps until one projects back onto the
      // constraints AND gets closer to the cursor.
      const here = this._captureParamValues(drag.state);
      let improved = false;
      for (let alpha = 1; alpha >= 1 / 32; alpha /= 2) {
        this._applyParamValues(drag.state, here);
        this._applyParamStep(drag.state, alpha === 1 ? step : step.map(v => v * alpha));
        this._projectConstraintResidual(drag.state, drag.constraints, 6, drag.lookup);
        const sysAfter = this._constraintSystem(drag.state, drag.constraints, drag.lookup);
        const err = this._dragIntentError(drag, dx, dy);
        if (sysAfter.residual < 1e-6 && err < bestError) {
          bestError = err;
          bestValues = this._captureParamValues(drag.state);
          improved = true;
          break;
        }
      }
      if (!improved) { this._applyParamValues(drag.state, bestValues); break; }
      if (bestError < 1e-5) break;
    }
    this._applyParamValues(drag.state, bestValues);
    return { values: bestValues, error: bestError, iterations };
  }


  _applySimilarityToRows(rows, component, anchor, scale, angle) {
    const cs = Math.cos(angle), sn = Math.sin(angle);
    const pointRows = new Map();
    for (const r of rows) {
      if (!component.has(r.id)) continue;
      if (r.ent instanceof Point) {
        if (!pointRows.has(r.ent)) pointRows.set(r.ent, { x:r.ent.x, y:r.ent.y });
        pointRows.get(r.ent)[r.key] = r.value;
      }
    }
    for (const [p, rec] of pointRows) {
      const vx = rec.x - anchor.x, vy = rec.y - anchor.y;
      p.x = anchor.x + scale * (vx*cs - vy*sn);
      p.y = anchor.y + scale * (vx*sn + vy*cs);
    }
    for (const r of rows) {
      if (!component.has(r.id) || r.ent instanceof Point) continue;
      if (r.key === 'r') r.ent[r.key] = Math.max(EPS, r.value * scale);
      else if (r.key === 'a0' || r.key === 'a1') r.ent[r.key] = r.value + angle;
      else r.ent[r.key] = r.value;
    }
  }

  _componentTransformFreedom(sketch, state, component, anchor) {
    const relevant = sketch.constraints.filter(c => !c.driven && c.refs().some(id => component.has(id)));
    const lookup = this._lookupFn(this.project.sketches);
    const before = this._constraintResidualNorm(relevant, lookup);
    const allowed = (scale, angle) => {
      this._applySimilarityToRows(state, component, anchor, scale, angle);
      const after = this._constraintResidualNorm(relevant, lookup);
      this._restoreSketchParams(state);
      return after <= Math.max(1e-5, before * 1.05 + 1e-6);
    };
    return {
      rotate: allowed(1, 0.01),
      scale: allowed(1.01, 0)
    };
  }

  beginLocalizedDrag(startWorld, pts, hit = null, rigidLines = []) {
    const sketch = this.activeSketch();
    this._ensureOffsetPairSigns(sketch);
    const state = this._captureSketchParams(sketch);
    const initialDragIds = new Set(pts.map(r => r.p.id));
    if (hit?.id) initialDragIds.add(hit.id);
    const offsetGuard = this._captureOffsetDragGuard(sketch, initialDragIds);
    // Circle perimeter resize: when the center is fully determined by constraints,
    // dragging the perimeter should resize the circle rather than translate it.
    if (hit instanceof Circle &&
        !sketch.constraints.some(c => c.kind === 'radius' && c.circleId === hit.id)) {
      return {
        mode: 'circleResize',
        startWorld,
        pts: [],
        snapPts: [],
        state,
        circle: hit,
        center: { x:hit.center.x, y:hit.center.y },
        offsetGuard,
        snapIgnoreIds: this._offsetLinkedSnapIgnoreIds(sketch, [hit.id, hit.center.id])
      };
    }

    const endpointRef = this.arcEndpointRef(hit);
    if (endpointRef && pts.length === 1) {
      // Track the dragged end continuously from the arc's current directed
      // span, so the sweep starts with the arc's real sign. Seeding it with
      // the raw angles flipped any arc that crosses the ±180° direction to
      // its complement on the first pixel of drag.
      const arc = hit.arcOwner;
      const span = directedArcSpan(arc.a0, arc.a1, arc.clockwise);
      const isStart = hit.arcEndpoint === 'start';
      return {
        mode:'arcEndpoint',
        startWorld,
        pts,
        snapPts:pts,
        state,
        endpointRef,
        arc:hit.arcOwner,
        which:hit.arcEndpoint,
        startRadius:hit.arcOwner.r,
        startAngle:isStart ? arc.a0 : arc.a1,
        referenceAngle:isStart ? arc.a1 : arc.a0,
        unwrappedAngle:isStart ? arc.a1 - span : arc.a0 + span,
        offsetGuard,
        snapIgnoreIds:this._offsetLinkedSnapIgnoreIds(sketch, [hit.id, hit.arcOwner.id])
      };
    }
    const jointKinds = this._dragJointConstraintKinds();
    const graph = this._buildConstraintGraph(sketch, { skipKinds: jointKinds });
    const startIds = new Set(pts.map(r => r.p.id));
    const distances = this._graphDistances(graph, startIds);
    const mirrorAxisLocks = this._mirrorAxisSourceLocksForDrag(sketch, hit, startIds);

    const { ids: activeIds, points: pointById } = this._activeIdsAndPoints(sketch);
    const isPointOnCircleHandleDrag = hit instanceof Point && pts.length === 1 &&
      sketch.constraints.some(c => c.kind === 'pointOnCircle' && c.pointId === hit.id);
    const components = [];
    const componentKeys = new Set();
    for (const id of startIds) {
      const component = this._componentFrom(graph, id);
      const key = [...component].sort().join('|');
      if (!componentKeys.has(key)) {
        componentKeys.add(key);
        components.push(component);
      }
    }

    if (!mirrorAxisLocks.length &&
        !isPointOnCircleHandleDrag &&
        components.length && components.every(c =>
          !this._componentIsAnchored(sketch, c, activeIds, pointById) &&
          !this._componentHasExternalJoint(sketch, c, jointKinds))) {
      const moveIds = new Set();
      for (const c of components) for (const id of c) moveIds.add(id);
      const rigidPts = [];
      for (const [id, p] of pointById) {
        if (moveIds.has(id)) rigidPts.push({ p, x:p.x, y:p.y });
      }
      if (rigidPts.length) {
        return {
          mode:'rigid',
          startWorld,
          pts:rigidPts,
          snapPts:pts,
          state,
          startIds,
          distances,
          rigidLines,
          mirrorAxisLocks,
          offsetGuard,
          snapIgnoreIds:this._offsetLinkedSnapIgnoreIds(sketch, moveIds)
        };
      }
    }

    const dofDrag = this._beginDofDrag(sketch, state, startWorld, pts, hit, distances, rigidLines, mirrorAxisLocks);
    let lockedDofDrag = dofDrag?.mode === 'locked' ? dofDrag : null;
    if (dofDrag && !lockedDofDrag) {
      dofDrag.offsetGuard = offsetGuard;
      return dofDrag;
    }

    const solveGraph = this._buildSolvingGraph(sketch);
    const solveComponents = [];
    const solveComponentKeys = new Set();
    for (const id of startIds) {
      const component = this._componentFrom(solveGraph, id);
      const key = [...component].sort().join('|');
      if (!solveComponentKeys.has(key)) {
        solveComponentKeys.add(key);
        solveComponents.push(component);
      }
    }

    if (!dofDrag || lockedDofDrag) {
      const fullDistances = this._graphDistances(solveGraph, startIds);
      const expandsThroughJoints = [...fullDistances.keys()].some(id => !distances.has(id));
      if (expandsThroughJoints) {
        const joinedDofDrag = this._beginDofDrag(sketch, state, startWorld, pts, hit, fullDistances, rigidLines, mirrorAxisLocks);
        if (joinedDofDrag && joinedDofDrag.mode !== 'locked') {
          joinedDofDrag.offsetGuard = offsetGuard;
          return joinedDofDrag;
        }
        if (!lockedDofDrag && joinedDofDrag?.mode === 'locked') lockedDofDrag = joinedDofDrag;
      }
    }

    const anchors = solveComponents.map(c => this._componentAnchorPoint(sketch, c, activeIds, pointById));
    if (!mirrorAxisLocks.length &&
        solveComponents.length && anchors.every(a => a) && new Set(anchors.map(a => a.id)).size === 1) {
      const anchor = anchors[0];
      const moveIds = new Set();
      for (const c of solveComponents) for (const id of c) moveIds.add(id);
      const snapIgnoreIds = this._offsetLinkedSnapIgnoreIds(sketch, moveIds);
      for (const c of components) for (const id of c) snapIgnoreIds.add(id);
      const rotatePts = [];
      for (const [id, p] of pointById) {
        if (moveIds.has(id) && p !== anchor) rotatePts.push({ p, x:p.x, y:p.y });
      }
      const transformFreedom = this._componentTransformFreedom(sketch, state, moveIds, anchor);
      const handle = dist(startWorld, anchor) > EPS ? { x:startWorld.x, y:startWorld.y } : pts
        .filter(r => r.p !== anchor && dist(r.p, anchor) > EPS)
        .sort((a, b) => dist(a.p, startWorld) - dist(b.p, startWorld))[0] || rotatePts[0];
      if (rotatePts.length && handle && transformFreedom.rotate) {
        const transformParams = state.filter(r => moveIds.has(r.id) && !(r.ent instanceof Point));
        return {
          mode: (transformFreedom.scale && !rigidLines.length) ? 'similarity' : 'rotate',
          startWorld,
          pts:rotatePts,
          transformParams,
          snapPts:pts.filter(r => r.p !== anchor),
          state,
          startIds,
          distances,
          rigidLines,
          mirrorAxisLocks,
          anchor:{ p:anchor, x:anchor.x, y:anchor.y },
          rotateHandle:handle,
          offsetGuard,
          snapIgnoreIds
        };
      }
    }

    if (lockedDofDrag) {
      lockedDofDrag.offsetGuard = offsetGuard;
      return lockedDofDrag;
    }

    const depthSet = new Set([0]);
    for (const r of state) {
      const d = distances.get(r.id);
      if (Number.isFinite(d)) depthSet.add(d);
    }
    const depths = [...depthSet].sort((a, b) => a - b);
    return { startWorld, pts, snapPts:pts, state, startIds, distances, depths, rigidLines, mirrorAxisLocks,
      offsetGuard,
      snapIgnoreIds:this._offsetLinkedSnapIgnoreIds(sketch, distances.keys()) };
  }

  _dragMovableIds(drag, depth) {
    const movable = new Set(drag.startIds);
    for (const [id, d] of drag.distances) {
      if (d <= depth) movable.add(id);
    }
    return movable;
  }

  _dragTempConstraints(state, movableIds, targetById, drag = null) {
    const extra = [];
    const fixedPoints = new Map();
    for (const r of state) {
      if (movableIds.has(r.id)) continue;
      if (r.ent instanceof Point) {
        if (!fixedPoints.has(r.ent)) fixedPoints.set(r.ent, { p:r.ent, x:r.ent.x, y:r.ent.y });
        fixedPoints.get(r.ent)[r.key] = r.value;
      } else {
        extra.push(new ParamFixConstraint(r.id, r.key, r.value));
      }
    }
    for (const fp of fixedPoints.values()) extra.push(new FixConstraint(fp.p.id, fp.x, fp.y));
    if (targetById) {
      for (const [id, t] of targetById) extra.push(new FixConstraint(id, t.x, t.y));
    }
    extra.push(...this._dragRigidLineConstraints(drag));
    if (drag?.mirrorAxisLocks) extra.push(...drag.mirrorAxisLocks);
    return extra;
  }

  _entityAndChildIds(entity) {
    const ids = new Set();
    const walk = (e) => {
      if (!e || ids.has(e.id)) return;
      ids.add(e.id);
      for (const c of e.children()) walk(c);
    };
    walk(entity);
    return ids;
  }

  _solveWithFirstSelectionMoving(sketch, sel, beforeState, beforeGraph) {
    if (!sketch || sel.length < 2) return null;
    const firstIds = this._entityAndChildIds(sel[0]);
    const movableIds = new Set();
    for (const id of firstIds) {
      const component = this._componentFrom(beforeGraph, id);
      for (const cid of component) movableIds.add(cid);
    }
    if (!movableIds.size) return null;

    const extra = this._dragTempConstraints(beforeState, movableIds, null);
    const result = this.solver.solve(sketch, this.project.sketches, extra, { diagnostics:false });
    if (result.ok) return result;

    this._restoreSketchParams(beforeState);
    return result;
  }

  shouldIgnoreDragSnap(drag, snap) {
    if (!drag || !snap) return false;
    if ((drag.mode === 'rotate' || drag.mode === 'similarity' || drag.mode === 'dof') && snap.kind === 'origin') {
      if (drag.anchor && Math.hypot(drag.anchor.x, drag.anchor.y) < EPS) return true;
      const fixedAtOrigin = (drag.state || []).some(r => r.ent instanceof Point && Math.hypot(r.ent.x, r.ent.y) < EPS && (r.ent.fixed || r.ent.locked));
      if (fixedAtOrigin) return true;
    }
    if (!snap.entity || !snap.entity.id) return false;
    return !!(drag.snapIgnoreIds && drag.snapIgnoreIds.has(snap.entity.id));
  }

  _snapKey(snap) {
    if (!snap) return '';
    const entityId = snap.entity?.id || '';
    return `${snap.kind || ''}:${entityId}:${Math.round((snap.x || 0) * 1e6)}:${Math.round((snap.y || 0) * 1e6)}`;
  }

  _rotationDeltaFromDrag(drag, dx, dy) {
    const h = drag.rotateHandle;
    const a = drag.anchor;
    if (!h || !a) return 0;
    const start = Math.atan2(h.y - a.y, h.x - a.x);
    const target = Math.atan2(h.y + dy - a.y, h.x + dx - a.x);
    let delta = target - start;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    return delta;
  }

  _similarityFromDrag(drag, dx, dy) {
    const h = drag.rotateHandle;
    const a = drag.anchor;
    if (!h || !a) return { delta:0, scale:1 };
    const sx = h.x - a.x, sy = h.y - a.y;
    const tx = h.x + dx - a.x, ty = h.y + dy - a.y;
    const startLen = Math.hypot(sx, sy);
    if (startLen < EPS) return { delta:0, scale:1 };
    let delta = Math.atan2(ty, tx) - Math.atan2(sy, sx);
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    const scale = drag.mode === 'similarity'
      ? Math.max(0.05, Math.hypot(tx, ty) / startLen)
      : 1;
    return { delta, scale };
  }

  _dragPreviewPoint(drag, r, dx, dy) {
    if (drag.mode !== 'rotate' && drag.mode !== 'similarity') return { x:r.x + dx, y:r.y + dy };
    const a = drag.anchor;
    const { delta, scale } = this._similarityFromDrag(drag, dx, dy);
    const cs = Math.cos(delta), sn = Math.sin(delta);
    const vx = r.x - a.x, vy = r.y - a.y;
    return {
      x:a.x + scale * (vx*cs - vy*sn),
      y:a.y + scale * (vx*sn + vy*cs)
    };
  }

  _dragDeltaForSnap(drag, snap) {
    if (drag.mode !== 'rotate' && drag.mode !== 'similarity') {
      return { dx:snap.x - snap.dragRecord.x, dy:snap.y - snap.dragRecord.y };
    }
    const r = snap.dragRecord;
    const a = drag.anchor;
    const h = drag.rotateHandle;
    if (!r || !a || !h) return { dx:0, dy:0 };
    const rsx = r.x - a.x, rsy = r.y - a.y;
    const rtx = snap.x - a.x, rty = snap.y - a.y;
    const rStartLen = Math.hypot(rsx, rsy);
    if (rStartLen < EPS) return { dx:0, dy:0 };
    let delta = Math.atan2(rty, rtx) - Math.atan2(rsy, rsx);
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    const scale = drag.mode === 'similarity'
      ? Math.max(0.05, Math.hypot(rtx, rty) / rStartLen)
      : 1;
    const cs = Math.cos(delta), sn = Math.sin(delta);
    const hvx = h.x - a.x, hvy = h.y - a.y;
    const hx = a.x + scale * (hvx*cs - hvy*sn);
    const hy = a.y + scale * (hvx*sn + hvy*cs);
    return { dx:hx - h.x, dy:hy - h.y };
  }

  solveLocalizedDrag(drag, dx, dy) {
    const sketch = this.activeSketch();
    if (!sketch || !drag) return null;

    if (drag.mode === 'circleResize') {
      if (!drag.warmStarted) {
        this._restoreSketchParams(drag.state || []);
        drag.warmStarted = true;
      }
      const cx = drag.center?.x ?? drag.circle.center.x;
      const cy = drag.center?.y ?? drag.circle.center.y;
      const radius = Math.max(EPS, Math.hypot(drag.startWorld.x + dx - cx, drag.startWorld.y + dy - cy));
      drag.circle.center.x = cx;
      drag.circle.center.y = cy;
      drag.circle.r = radius;
      const extra = [
        new FixConstraint(drag.circle.center.id, cx, cy),
        new ParamFixConstraint(drag.circle.id, 'r', radius)
      ];
      const result = this.solver.solve(sketch, this.project.sketches, extra, {
        diagnostics:false,
        activeIds:[drag.circle.id, drag.circle.center.id]
      });
      return this._finishDragStep(drag, result);
    }

    if (!drag.pts.length) return null;

    if (drag.mode === 'dof') {
      return this._solveDofDrag(drag, dx, dy);
    }

    if (drag.mode === 'locked') {
      this._restoreSketchParams(drag.state || []);
      return { ok:true, iters:0, residual:0, state:this._lastSolve?.state || 'fully' };
    }

    if (drag.mode === 'arcEndpoint') {
      this._restoreSketchParams(drag.state || []);
      const arc = drag.arc;
      const target = { x:drag.pts[0].x + dx, y:drag.pts[0].y + dy };
      const vx = target.x - arc.center.x;
      const vy = target.y - arc.center.y;
      const r = Math.hypot(vx, vy);
      if (r > EPS) {
        const angle = Math.atan2(vy, vx);
        const unwrapped = unwrapAngleNear(angle, drag.unwrappedAngle ?? angle);
        drag.unwrappedAngle = unwrapped;
        const sweep = drag.which === 'start'
          ? drag.referenceAngle - unwrapped
          : unwrapped - drag.referenceAngle;
        if (Math.abs(sweep) > 1e-3) arc.clockwise = sweep < 0;
        arc.r = r;
        if (drag.which === 'start') arc.a0 = angle;
        else arc.a1 = angle;
      }
      arc.syncEnds();
      return this._finishDragStep(drag, { ok:true, iters:0, residual:0, state:this._lastSolve?.state || 'under' });
    }

    if (drag.mode === 'rotate' || drag.mode === 'similarity') {
      const a = drag.anchor;
      const { delta, scale } = this._similarityFromDrag(drag, dx, dy);
      const cs = Math.cos(delta), sn = Math.sin(delta);
      for (const r of drag.pts) {
        const vx = r.x - a.x, vy = r.y - a.y;
        r.p.x = a.x + scale * (vx*cs - vy*sn);
        r.p.y = a.y + scale * (vx*sn + vy*cs);
      }
      for (const r of drag.transformParams || []) {
        if (r.key === 'r') r.ent[r.key] = Math.max(EPS, r.value * scale);
        else if (r.key === 'a0' || r.key === 'a1') r.ent[r.key] = r.value + delta;
        else r.ent[r.key] = r.value;
      }
      for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
      return this._finishDragStep(drag, { ok:true, iters:0, residual:0, state:this._lastSolve?.state || 'under' });
    }

    if (drag.mode === 'rigid') {
      for (const r of drag.pts) {
        r.p.x = r.x + dx;
        r.p.y = r.y + dy;
      }
      for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
      return this._finishDragStep(drag, { ok:true, iters:0, residual:0, state:this._lastSolve?.state || 'under' });
    }

    const targets = new Map();
    for (const r of drag.pts) targets.set(r.p.id, { x:r.x + dx, y:r.y + dy });

    let best = null;
    const placeDraggedPoints = () => {
      for (const r of drag.pts) {
        const t = targets.get(r.p.id);
        r.p.x = t.x;
        r.p.y = t.y;
      }
    };
    const finish = (result) => {
      // Drag solves use temporary pins to keep unaffected geometry local.
      // Those pins are not real sketch constraints, so do not use their
      // fully-defined analysis for canvas colouring while the pointer moves.
      return this._finishDragStep(drag, result);
    };
    const trySolve = (depth, includeTargets) => {
      this._restoreSketchParams(drag.state);
      placeDraggedPoints();
      const movable = this._dragMovableIds(drag, depth);
      const extra = this._dragTempConstraints(drag.state, movable, includeTargets ? targets : null, drag);
      const result = this.solver.solve(sketch, this.project.sketches, extra, { diagnostics:false });
      const values = this._captureParamValues(drag.state);
      if (!best || result.residual < best.result.residual) best = { result, values };
      return result;
    };

    for (const depth of drag.depths) {
      const result = trySolve(depth, true);
      if (result.ok) return finish(result);
    }

    // If the cursor target conflicts with a real fixed/reference relation,
    // keep the local pins but let the actual sketch constraints win.
    for (const depth of drag.depths) {
      const result = trySolve(depth, false);
      if (result.ok) return finish(result);
    }

    if (best) {
      this._applyParamValues(drag.state, best.values);
      return finish(best.result);
    }
    return null;
  }
}

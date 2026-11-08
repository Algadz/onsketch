import { evaluate } from '../core/expr.js';
import { EPS, TAU, angleOnDirectedArc, directedArcSpan, dist, lineIntersection, mirrorPointAcrossLine, offsetArc, offsetCircle, offsetLine } from '../core/math.js';
import { uiIcon } from '../ui/icons.js';
import { Arc, Circle, Line, Point, newId } from '../core/entities.js';
import { AngleConstraint, ArcEndpointArcEndpointCoincidentConstraint, ArcEndpointCoincidentConstraint, ArcEndpointMidpointConstraint, ArcEndpointOnCircleConstraint, ArcEndpointOnLineConstraint, CoincidentConstraint, CollinearConstraint, ConcentricConstraint, Constraint, DirectedAngleConstraint, EqualLengthConstraint, EqualRadiusConstraint, HorizontalConstraint, MidpointConstraint, OffsetConstraint, OffsetDistanceConstraint, ParallelConstraint, ParamFixConstraint, PerpendicularConstraint, PointOnCircleConstraint, PointOnLineConstraint, PointRefHorizontalConstraint, PointRefVerticalConstraint, SymmetricConstraint, TangentCircleCircleConstraint, TangentLineCircleConstraint, VerticalConstraint } from '../core/constraints.js';
import { SelectTool } from '../tools/select.js';

/** Mirrored and offset copies keep their source's layer and style. */
function copyDisplay(src, dst) {
  dst.layerId = src.layerId;
  dst.style = src.style ? { ...src.style } : null;
}

export class OperationsMixin {

  /* ---- Operations ---- */
  _clearOperationState() {
    if (this.offsetInputEl) { this.offsetInputEl.remove(); this.offsetInputEl = null; }
    this.operationName = null;
    this.mirrorPickMode = 'entities';
    this.mirrorEntityIds = [];
    this.mirrorAxisId = null;
    this.offsetEntityIds = [];
    this.offsetAnchorId = null;
    this.offsetPhase = 'selecting';
    this.offsetSide = 1;
  }

  cancelOperation() {
    if (!this.operationName) return false;
    this._clearOperationState();
    document.getElementById('status-hint').textContent = (this.tool.hint && this.tool.hint()) || '';
    this.refreshToolOptions();
    this.requestRender();
    return true;
  }

  cancelOffsetOperation() {
    if (this.operationName !== 'offset') return;
    this.cancelOperation();
  }

  _switchToSelectToolForOperation() {
    if (this.toolName === 'select') return;
    if (this.tool && this.tool.deactivate) this.tool.deactivate();
    this.toolName = 'select';
    this.tool = new SelectTool(this);
    if (this.tool.activate) this.tool.activate();
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
    document.getElementById('status-tool').textContent = 'Tool: Select';
    this.canvas.style.cursor = 'default';
  }

  startMirrorOperation() {
    this._clearOperationState();
    this._switchToSelectToolForOperation();
    this.operationName = 'mirror';
    const data = this._mirrorDataFromSelection();
    this.mirrorEntityIds = data.entityIds;
    this.mirrorAxisId = data.axisId;
    this._syncMirrorSelection();
    this.refreshToolOptions();
  }

  startOffsetOperation() {
    this._clearOperationState();
    this._switchToSelectToolForOperation();
    this.operationName = 'offset';
    const entities = this._offsetEntitiesFromSelection();
    this.offsetEntityIds = entities.map(e => e.id);
    this.offsetAnchorId = entities[0]?.id || null;
    this.offsetPhase = entities.length ? 'placing' : 'selecting';
    if (this.offsetAnchorId && this.lastWorldCursor) this.updateOffsetCursor(this.lastWorldCursor);
    this._syncOffsetSelection();
    this.refreshToolOptions();
  }

  _entityLabel(e) {
    const kind = e instanceof Point ? 'Point'
      : e instanceof Line ? 'Line'
      : e instanceof Circle ? 'Circle'
      : e instanceof Arc ? 'Arc'
      : e?.constructor?.kind || 'Entity';
    return `${kind} ${e.id}`;
  }

  _offsetEntitiesFromSelection() {
    const sketch = this.activeSketch(); if (!sketch) return null;
    const sel = this.selectedEntitiesAndPoints().filter(e => !(e instanceof Constraint));
    const entities = sel.filter(e => e instanceof Line || e instanceof Circle || e instanceof Arc);
    return this._offsetProfileEntities(entities, sketch);
  }

  _normalizeOffsetEntityIds() {
    const sketch = this.activeSketch(); if (!sketch) return;
    const entities = this.offsetEntityIds
      .map(id => this._lookupAny(id))
      .filter(e => e && this.project.sketchOf(e) === sketch && (e instanceof Line || e instanceof Circle || e instanceof Arc));
    this.offsetEntityIds = this._offsetProfileEntities(entities, sketch).map(e => e.id);
    if (!this.offsetEntityIds.includes(this.offsetAnchorId)) this.offsetAnchorId = this.offsetEntityIds[0] || null;
  }

  _offsetEntities() {
    const sketch = this.activeSketch(); if (!sketch) return [];
    const entities = this.offsetEntityIds
      .map(id => this._lookupAny(id))
      .filter(e => e && this.project.sketchOf(e) === sketch && (e instanceof Line || e instanceof Circle || e instanceof Arc));
    return this._offsetProfileEntities(entities, sketch);
  }

  _offsetProfileEntities(entities, sketch) {
    if (!entities || !entities.length) return [];
    const real = entities.filter(e => !e.construction);
    if (!real.length) return entities;

    const realEntityIds = new Set(real.map(e => e.id));
    const realPointIds = new Set();
    for (const e of real) {
      for (const child of e.children()) {
        if (child instanceof Point) realPointIds.add(child.id);
      }
    }

    const isScaffold = (e) => {
      if (!e.construction) return false;
      if (e instanceof Line) return true;
      if (e instanceof Circle || e instanceof Arc) {
        return this._constructionCurveSupportsOffsetProfile(sketch, e, realEntityIds, realPointIds);
      }
      return false;
    };
    const filtered = entities.filter(e => !isScaffold(e));
    return filtered.length ? filtered : entities;
  }

  _constructionCurveSupportsOffsetProfile(sketch, curve, realEntityIds, realPointIds) {
    if (!sketch || !(curve instanceof Circle || curve instanceof Arc)) return false;
    for (const c of sketch.constraints) {
      if (c.kind === 'pointOnCircle' &&
          c.circleId === curve.id &&
          c.centerId === curve.center.id &&
          realPointIds.has(c.pointId)) {
        return true;
      }
      if (c.kind === 'arcEndpointOnCircle' &&
          c.circleId === curve.id &&
          c.centerId === curve.center.id &&
          c.ref && realEntityIds.has(c.ref.arcId)) {
        return true;
      }
    }
    return false;
  }

  _offsetSignedDistance() {
    const d = Math.abs(Number(this.offsetDistance) || 0);
    return d * (this.offsetSide >= 0 ? 1 : -1);
  }

  _offsetGroupBounds(entities = this._offsetEntities()) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (p) => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    };
    for (const e of entities) {
      if (e instanceof Line) {
        acc(e.p1); acc(e.p2);
      } else if (e instanceof Circle || e instanceof Arc) {
        acc({ x:e.center.x - e.r, y:e.center.y - e.r });
        acc({ x:e.center.x + e.r, y:e.center.y + e.r });
      }
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  _offsetGroupCenter(entities = this._offsetEntities()) {
    const bounds = this._offsetGroupBounds(entities);
    if (!bounds) return null;
    let wx = 0, wy = 0, weight = 0;
    const addWeighted = (p, w) => {
      if (!Number.isFinite(w) || w <= EPS) return;
      wx += p.x * w; wy += p.y * w; weight += w;
    };
    for (const e of entities) {
      if (e instanceof Line) {
        const len = dist(e.p1, e.p2);
        addWeighted({ x:(e.p1.x + e.p2.x) / 2, y:(e.p1.y + e.p2.y) / 2 }, len);
      } else if (e instanceof Circle || e instanceof Arc) {
        if (e instanceof Circle) {
          addWeighted(e.center, TAU * e.r);
        } else {
          const span = Math.abs(directedArcSpan(e.a0, e.a1, e.clockwise));
          const mid = e.a0 + directedArcSpan(e.a0, e.a1, e.clockwise) / 2;
          addWeighted({ x:e.center.x + e.r * Math.cos(mid), y:e.center.y + e.r * Math.sin(mid) }, span * e.r);
        }
      }
    }
    return weight > EPS
      ? { x:wx / weight, y:wy / weight }
      : { x:(bounds.minX + bounds.maxX) / 2, y:(bounds.minY + bounds.maxY) / 2 };
  }

  _offsetRayBoxBoundaryDistance(center, ux, uy, bounds) {
    if (!bounds) return null;
    let best = Infinity;
    const note = (t, x, y) => {
      if (!Number.isFinite(t) || t <= EPS) return;
      if (x < bounds.minX - 1e-6 || x > bounds.maxX + 1e-6) return;
      if (y < bounds.minY - 1e-6 || y > bounds.maxY + 1e-6) return;
      best = Math.min(best, t);
    };
    if (Math.abs(ux) > EPS) {
      let t = (bounds.minX - center.x) / ux;
      note(t, bounds.minX, center.y + uy * t);
      t = (bounds.maxX - center.x) / ux;
      note(t, bounds.maxX, center.y + uy * t);
    }
    if (Math.abs(uy) > EPS) {
      let t = (bounds.minY - center.y) / uy;
      note(t, center.x + ux * t, bounds.minY);
      t = (bounds.maxY - center.y) / uy;
      note(t, center.x + ux * t, bounds.maxY);
    }
    return Number.isFinite(best) ? best : null;
  }

  _offsetGroupSignedDistanceFromCursor(world) {
    const entities = this._offsetEntities();
    const bounds = this._offsetGroupBounds(entities);
    const center = this._offsetGroupCenter(entities);
    if (!center || !world) return null;
    const vx = world.x - center.x, vy = world.y - center.y;
    const cursorR = Math.hypot(vx, vy);
    if (cursorR < EPS) return null;
    const ux = vx / cursorR, uy = vy / cursorR;
    let boundaryR = Infinity;
    const note = (t) => {
      if (Number.isFinite(t) && t > EPS && t < boundaryR) boundaryR = t;
    };
    for (const e of entities) {
      if (e instanceof Line) {
        const sx = e.p2.x - e.p1.x, sy = e.p2.y - e.p1.y;
        const denom = ux * sy - uy * sx;
        if (Math.abs(denom) < EPS) continue;
        const qx = e.p1.x - center.x, qy = e.p1.y - center.y;
        const t = (qx * sy - qy * sx) / denom;
        const s = (qx * uy - qy * ux) / denom;
        if (s >= -1e-6 && s <= 1 + 1e-6) note(t);
      } else if (e instanceof Circle || e instanceof Arc) {
        const cx = center.x - e.center.x, cy = center.y - e.center.y;
        const b = 2 * (ux * cx + uy * cy);
        const c = cx*cx + cy*cy - e.r*e.r;
        const disc = b*b - 4*c;
        if (disc < -EPS) continue;
        const root = Math.sqrt(Math.max(0, disc));
        for (const t of [(-b - root) / 2, (-b + root) / 2]) {
          if (t <= EPS) continue;
          if (e instanceof Arc) {
            const px = center.x + ux * t, py = center.y + uy * t;
            if (!angleOnDirectedArc(Math.atan2(py - e.center.y, px - e.center.x), e.a0, e.a1, e.clockwise)) continue;
          }
          note(t);
        }
      }
    }
    if (!Number.isFinite(boundaryR)) {
      const boxR = this._offsetRayBoxBoundaryDistance(center, ux, uy, bounds);
      if (boxR == null) return null;
      boundaryR = boxR;
    }
    const radialOffset = cursorR - boundaryR;
    if (this._offsetHasClosedLineComponent(entities)) return radialOffset;
    const anchor = this.offsetAnchorId ? this._lookupAny(this.offsetAnchorId) : null;
    if (anchor instanceof Line) {
      const dx = anchor.p2.x - anchor.p1.x;
      const dy = anchor.p2.y - anchor.p1.y;
      const len = Math.hypot(dx, dy);
      if (len > EPS) {
        const nx = -dy / len, ny = dx / len;
        const centerSide = (center.x - anchor.p1.x) * nx + (center.y - anchor.p1.y) * ny;
        if (Math.abs(centerSide) > EPS) return radialOffset * (centerSide < 0 ? 1 : -1);
      }
    }
    return radialOffset;
  }

  _offsetEndpointPair(entity) {
    if (entity instanceof Line) return { a: entity.p1.id, b: entity.p2.id };
    if (entity instanceof Arc) return { a: entity.start.id, b: entity.end.id };
    return null;
  }

  _offsetTopologyIssue(entities) {
    if (!entities || !entities.length) return null;
    const pathEntities = entities.filter(e => e instanceof Line || e instanceof Arc);
    const endpointOwners = new Map();
    const entityById = new Map(pathEntities.map(e => [e.id, e]));
    const neighbors = new Map(pathEntities.map(e => [e.id, new Set()]));

    for (const e of pathEntities) {
      const pair = this._offsetEndpointPair(e);
      if (!pair) continue;
      for (const pointId of [pair.a, pair.b]) {
        if (!endpointOwners.has(pointId)) endpointOwners.set(pointId, []);
        endpointOwners.get(pointId).push(e);
      }
    }

    for (const [pointId, owners] of endpointOwners.entries()) {
      if (owners.length > 2) {
        return `Offset only supports simple path or loop groups. ${owners.length} elements meet at one point; split the branch into separate offsets.`;
      }
      if (owners.length === 2) {
        neighbors.get(owners[0].id).add(owners[1].id);
        neighbors.get(owners[1].id).add(owners[0].id);
      }
    }

    const seen = new Set();
    for (const e of pathEntities) {
      if (seen.has(e.id)) continue;
      const component = [];
      const queue = [e.id];
      seen.add(e.id);
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        const entity = entityById.get(id);
        if (entity) component.push(entity);
        for (const nb of neighbors.get(id) || []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          queue.push(nb);
        }
      }

      const degrees = new Map();
      for (const entity of component) {
        const pair = this._offsetEndpointPair(entity);
        if (!pair) continue;
        degrees.set(pair.a, (degrees.get(pair.a) || 0) + 1);
        degrees.set(pair.b, (degrees.get(pair.b) || 0) + 1);
      }
      const values = [...degrees.values()];
      if (values.some(n => n > 2)) {
        return 'Offset only supports simple path or loop groups. Remove branches or overlapping endpoints from the selection.';
      }
      const openEnds = values.filter(n => n === 1).length;
      if (!(openEnds === 0 || openEnds === 2)) {
        return 'Offset only supports groups that form one open chain or one closed loop.';
      }
    }

    return null;
  }

  _offsetHasClosedLineComponent(entities) {
    const lines = entities.filter(e => e instanceof Line);
    if (lines.length < 3) return false;
    const byId = new Map(lines.map(l => [l.id, l]));
    const neighbors = new Map(lines.map(l => [l.id, []]));
    const owners = new Map();
    for (const line of lines) {
      for (const p of [line.p1, line.p2]) {
        if (!owners.has(p.id)) owners.set(p.id, []);
        owners.get(p.id).push(line);
      }
    }
    for (const group of owners.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          neighbors.get(group[i].id).push(group[j].id);
          neighbors.get(group[j].id).push(group[i].id);
        }
      }
    }
    const seen = new Set();
    for (const line of lines) {
      if (seen.has(line.id)) continue;
      const component = [];
      const q = [line.id];
      seen.add(line.id);
      for (let qi = 0; qi < q.length; qi++) {
        const id = q[qi];
        const l = byId.get(id);
        if (l) component.push(l);
        for (const nb of neighbors.get(id) || []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          q.push(nb);
        }
      }
      if (component.length < 3) continue;
      const counts = new Map();
      for (const l of component) {
        counts.set(l.p1.id, (counts.get(l.p1.id) || 0) + 1);
        counts.set(l.p2.id, (counts.get(l.p2.id) || 0) + 1);
      }
      if ([...counts.values()].every(n => n === 2)) return true;
    }
    return false;
  }

  _offsetLocalVector(entity, endpointId) {
    if (entity instanceof Line) {
      const dx = entity.p2.x - entity.p1.x;
      const dy = entity.p2.y - entity.p1.y;
      const len = Math.hypot(dx, dy);
      if (len < EPS) return null;
      return { x: -dy / len, y: dx / len };
    }
    if (entity instanceof Arc) {
      entity.syncEnds();
      const p = endpointId === entity.start.id ? entity.start : endpointId === entity.end.id ? entity.end : null;
      if (!p) return null;
      const dx = p.x - entity.center.x;
      const dy = p.y - entity.center.y;
      const len = Math.hypot(dx, dy);
      if (len < EPS) return null;
      return { x: dx / len, y: dy / len };
    }
    return null;
  }

  _offsetRelationAtConnection(a, b, sharedId) {
    const ea = this._offsetEndpointPair(a);
    const eb = this._offsetEndpointPair(b);
    if (!ea || !eb) return 1;
    if (a instanceof Line && b instanceof Line) {
      const sameEnd = (ea.a === sharedId && eb.a === sharedId) || (ea.b === sharedId && eb.b === sharedId);
      return sameEnd ? -1 : 1;
    }
    const va = this._offsetLocalVector(a, sharedId);
    const vb = this._offsetLocalVector(b, sharedId);
    if (va && vb) {
      const dot = va.x * vb.x + va.y * vb.y;
      if (Math.abs(dot) > 1e-4) return dot >= 0 ? 1 : -1;
    }
    const sameSide = (ea.a === sharedId && eb.a === sharedId) || (ea.b === sharedId && eb.b === sharedId);
    return sameSide ? -1 : 1;
  }

  _offsetEntitySigns(entities) {
    const signs = new Map();
    const byId = new Map(entities.map(e => [e.id, e]));
    const neighbors = new Map(entities.map(e => [e.id, []]));
    const endpointOwners = new Map();
    for (const e of entities) {
      const pair = this._offsetEndpointPair(e);
      if (!pair) continue;
      for (const id of [pair.a, pair.b]) {
        if (!endpointOwners.has(id)) endpointOwners.set(id, []);
        endpointOwners.get(id).push(e);
      }
    }
    for (const [sharedId, owners] of endpointOwners.entries()) {
      for (let i = 0; i < owners.length; i++) {
        for (let j = i + 1; j < owners.length; j++) {
          const a = owners[i], b = owners[j];
          const rel = this._offsetRelationAtConnection(a, b, sharedId);
          neighbors.get(a.id).push({ id: b.id, rel });
          neighbors.get(b.id).push({ id: a.id, rel });
        }
      }
    }

    const lineComponents = [];
    const seenLines = new Set();
    for (const e of entities) {
      if (!(e instanceof Line) || seenLines.has(e.id)) continue;
      const component = [];
      const queue = [e.id];
      seenLines.add(e.id);
      while (queue.length) {
        const id = queue.shift();
        const line = byId.get(id);
        if (line instanceof Line) component.push(line);
        for (const nb of neighbors.get(id) || []) {
          const next = byId.get(nb.id);
          if (!(next instanceof Line) || seenLines.has(nb.id)) continue;
          seenLines.add(nb.id);
          queue.push(nb.id);
        }
      }
      if (component.length) lineComponents.push(component);
    }

    const closedLineComponents = [];
    for (const component of lineComponents) {
      if (component.length < 3) continue;
      const counts = new Map();
      for (const line of component) {
        counts.set(line.p1.id, (counts.get(line.p1.id) || 0) + 1);
        counts.set(line.p2.id, (counts.get(line.p2.id) || 0) + 1);
      }
      if ([...counts.values()].every(n => n === 2)) closedLineComponents.push(component);
    }

    const roots = [];
    if (this.offsetAnchorId && byId.has(this.offsetAnchorId)) roots.push(this.offsetAnchorId);
    for (const e of entities) if (!roots.includes(e.id)) roots.push(e.id);
    for (const root of roots) {
      if (signs.has(root)) continue;
      signs.set(root, 1);
      const queue = [root];
      while (queue.length) {
        const id = queue.shift();
        const base = signs.get(id);
        for (const nb of neighbors.get(id) || []) {
          if (signs.has(nb.id)) continue;
          signs.set(nb.id, base * nb.rel);
          queue.push(nb.id);
        }
      }
    }

    const groupCenter = closedLineComponents.length ? this._offsetGroupCenter(entities) : null;
    if (groupCenter) {
      for (const component of closedLineComponents) {
        for (const line of component) {
          const dx = line.p2.x - line.p1.x;
          const dy = line.p2.y - line.p1.y;
          const len = Math.hypot(dx, dy);
          if (len < EPS) continue;
          const nx = -dy / len, ny = dx / len;
          const side = (groupCenter.x - line.p1.x) * nx + (groupCenter.y - line.p1.y) * ny;
          if (Math.abs(side) > EPS) signs.set(line.id, side > 0 ? -1 : 1);
        }
      }
    }
    return signs;
  }

  _offsetDistanceFromCursor(world) {
    const groupSigned = this._offsetGroupSignedDistanceFromCursor(world);
    if (groupSigned != null) return Math.abs(groupSigned);
    const entity = this.offsetAnchorId ? this._lookupAny(this.offsetAnchorId) : null;
    if (!entity || !world) return null;
    if (entity instanceof Line) {
      const dx = entity.p2.x - entity.p1.x;
      const dy = entity.p2.y - entity.p1.y;
      const len = Math.hypot(dx, dy);
      if (len < EPS) return null;
      const nx = -dy / len, ny = dx / len;
      return Math.abs((world.x - entity.p1.x) * nx + (world.y - entity.p1.y) * ny);
    }
    return Math.abs(dist(world, entity.center) - entity.r);
  }

  _offsetCursorSide(entity, world) {
    const groupSigned = this._offsetGroupSignedDistanceFromCursor(world);
    if (groupSigned != null && Math.abs(groupSigned) > EPS) return groupSigned >= 0 ? 1 : -1;
    if (!entity || !world) return null;
    if (entity instanceof Line) {
      const dx = entity.p2.x - entity.p1.x;
      const dy = entity.p2.y - entity.p1.y;
      const len = Math.hypot(dx, dy);
      if (len < EPS) return null;
      const nx = -dy / len, ny = dx / len;
      const signed = (world.x - entity.p1.x) * nx + (world.y - entity.p1.y) * ny;
      if (Math.abs(signed) < EPS) return null;
      return signed >= 0 ? 1 : -1;
    }
    const radial = dist(world, entity.center) - entity.r;
    if (Math.abs(radial) < EPS) return null;
    return radial >= 0 ? 1 : -1;
  }

  _offsetLineNetworkPreview(lines, signs, signedDistance) {
    const raw = new Map();
    for (const line of lines) {
      const shifted = offsetLine(line, signedDistance * (signs.get(line.id) || 1));
      if (!shifted) return null;
      raw.set(line.id, { source: line, kind:'line', p1: shifted.p1, p2: shifted.p2 });
    }
    const endpointOwners = new Map();
    for (const line of lines) {
      for (const point of [line.p1, line.p2]) {
        if (!endpointOwners.has(point.id)) endpointOwners.set(point.id, []);
        endpointOwners.get(point.id).push(line);
      }
    }
    const pinned = new Map();
    const endpointKey = (line, which) => `${line.id}:${which}`;
    for (const [pointId, owners] of endpointOwners.entries()) {
      if (owners.length !== 2) continue;
      const [a, b] = owners;
      const sa = raw.get(a.id), sb = raw.get(b.id);
      if (!sa || !sb) continue;
      const inter = lineIntersection(sa.p1, sa.p2, sb.p1, sb.p2);
      if (!inter) continue;
      pinned.set(endpointKey(a, a.p1.id === pointId ? 'p1' : 'p2'), inter);
      pinned.set(endpointKey(b, b.p1.id === pointId ? 'p1' : 'p2'), inter);
    }
    const items = [];
    for (const line of lines) {
      const shifted = raw.get(line.id);
      const p1 = pinned.get(endpointKey(line, 'p1')) || shifted.p1;
      const p2 = pinned.get(endpointKey(line, 'p2')) || shifted.p2;
      const sdx = line.p2.x - line.p1.x, sdy = line.p2.y - line.p1.y;
      const tdx = p2.x - p1.x, tdy = p2.y - p1.y;
      if (Math.hypot(sdx, sdy) < EPS || Math.hypot(tdx, tdy) < EPS) return null;
      if (sdx * tdx + sdy * tdy <= EPS) return null;
      items.push({
        kind:'line',
        source: line,
        p1,
        p2
      });
    }
    if (!this._offsetLineNetworkPreviewTopologyValid(lines, items)) return null;
    return items;
  }

  _offsetLineNetworkPreviewTopologyValid(lines, items) {
    const lineIds = lines.map(l => l.id);
    const loops = this._closedLineLoopsFromEntityIds(lineIds);
    if (!loops.length) return true;

    const previewPointBySourcePointId = new Map();
    const sourceLineById = new Map(lines.map(l => [l.id, l]));
    for (const item of items) {
      const line = item.source;
      if (!(line instanceof Line) || !sourceLineById.has(line.id)) continue;
      previewPointBySourcePointId.set(line.p1.id, item.p1);
      previewPointBySourcePointId.set(line.p2.id, item.p2);
    }

    const previewArea = (pointIds) => {
      let area = 0;
      for (let i = 0; i < pointIds.length; i++) {
        const a = previewPointBySourcePointId.get(pointIds[i]);
        const b = previewPointBySourcePointId.get(pointIds[(i + 1) % pointIds.length]);
        if (!a || !b) return 0;
        area += a.x * b.y - b.x * a.y;
      }
      return area / 2;
    };

    for (const loop of loops) {
      const sourceArea = this._signedAreaForPointIds(loop.pointIds);
      if (Math.abs(sourceArea) <= EPS) continue;
      const targetArea = previewArea(loop.pointIds);
      if (Math.abs(targetArea) <= Math.max(EPS, Math.abs(sourceArea) * 1e-3)) return false;
      if (Math.sign(targetArea) !== Math.sign(sourceArea)) return false;
      for (let i = 0; i < loop.pointIds.length; i++) {
        const sourceA = this._lookupAny(loop.pointIds[i]);
        const sourceB = this._lookupAny(loop.pointIds[(i + 1) % loop.pointIds.length]);
        const targetA = previewPointBySourcePointId.get(loop.pointIds[i]);
        const targetB = previewPointBySourcePointId.get(loop.pointIds[(i + 1) % loop.pointIds.length]);
        if (!sourceA || !sourceB || !targetA || !targetB) return false;
        const sourceLen = dist(sourceA, sourceB);
        const targetLen = dist(targetA, targetB);
        if (targetLen <= Math.max(EPS, sourceLen * 1e-3)) return false;
      }
    }
    return true;
  }

  _applyOffsetPreviewConstraintRadii(preview, sketch) {
    if (!preview || !sketch) return preview;
    const itemBySourceId = new Map();
    const previewPointBySourceId = new Map();
    for (const item of preview.items) {
      const source = item.source;
      if (!source) continue;
      itemBySourceId.set(source.id, item);
      if (source instanceof Line && item.kind === 'line') {
        previewPointBySourceId.set(source.p1.id, item.p1);
        previewPointBySourceId.set(source.p2.id, item.p2);
      } else if ((source instanceof Circle || source instanceof Arc) && (item.kind === 'circle' || item.kind === 'arc')) {
        previewPointBySourceId.set(source.center.id, item.center);
        if (source instanceof Arc) {
          previewPointBySourceId.set(source.start.id, {
            x: item.center.x + item.r * Math.cos(item.a0),
            y: item.center.y + item.r * Math.sin(item.a0)
          });
          previewPointBySourceId.set(source.end.id, {
            x: item.center.x + item.r * Math.cos(item.a1),
            y: item.center.y + item.r * Math.sin(item.a1)
          });
        }
      }
    }

    const hasPreviewRef = (id) => itemBySourceId.has(id) || previewPointBySourceId.has(id);
    const setRadiusFromPoint = (curveId, centerId, pointId) => {
      const item = itemBySourceId.get(curveId);
      const center = previewPointBySourceId.get(centerId);
      const point = previewPointBySourceId.get(pointId);
      if (!item || !center || !point) return;
      const r = dist(center, point);
      if (r > EPS) item.r = r;
    };

    for (const c of sketch.constraints) {
      if (c.kind === 'pointOnCircle') {
        if ([c.pointId, c.circleId, c.centerId].every(hasPreviewRef)) {
          setRadiusFromPoint(c.circleId, c.centerId, c.pointId);
        }
      } else if (c.kind === 'arcEndpointOnCircle') {
        if ([c.ref.arcId, c.ref.centerId, c.circleId, c.centerId].every(hasPreviewRef)) {
          const refPointId = c.ref.which === 'start'
            ? this._lookupAny(c.ref.arcId)?.start?.id
            : this._lookupAny(c.ref.arcId)?.end?.id;
          if (refPointId) setRadiusFromPoint(c.circleId, c.centerId, refPointId);
        }
      }
    }
    return preview;
  }

  _offsetPreviewDataForSignedDistance(entities, signs, signedDistance) {
    const items = [];
    const lines = entities.filter(e => e instanceof Line);
    if (lines.length) {
      const lineItems = this._offsetLineNetworkPreview(lines, signs, signedDistance);
      if (!lineItems) return null;
      for (const item of lineItems) item.offsetValue = signedDistance * (signs.get(item.source.id) || 1);
      items.push(...lineItems);
    }
    for (const entity of entities) {
      if (entity instanceof Line) continue;
      const entityDistance = signedDistance * (signs.get(entity.id) || 1);
      let shifted = null;
      if (entity instanceof Circle) shifted = offsetCircle(entity, entityDistance) && { kind: 'circle', ...offsetCircle(entity, entityDistance) };
      else if (entity instanceof Arc) shifted = offsetArc(entity, entityDistance) && { kind: 'arc', ...offsetArc(entity, entityDistance) };
      if (!shifted) return null;
      shifted.source = entity;
      shifted.offsetValue = entityDistance;
      items.push(shifted);
    }
    return this._applyOffsetPreviewConstraintRadii({ items }, this.activeSketch());
  }

  _clampOffsetDistanceToValidRange(entities, signs, signedDistance) {
    const direction = signedDistance >= 0 ? 1 : -1;
    const target = Math.abs(signedDistance);
    let lo = 0, hi = target;
    let best = null;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      const preview = this._offsetPreviewDataForSignedDistance(entities, signs, direction * mid);
      if (preview) {
        lo = mid;
        best = preview;
      } else {
        hi = mid;
      }
    }
    return best;
  }

  _offsetPreviewData() {
    const entities = this._offsetEntities();
    if (!entities.length) return null;
    if (this._offsetTopologyIssue(entities)) return null;
    const signedDistance = this._offsetSignedDistance();
    if (Math.abs(signedDistance) < EPS) return null;
    const signs = this._offsetEntitySigns(entities);
    return this._offsetPreviewDataForSignedDistance(entities, signs, signedDistance)
      || this._clampOffsetDistanceToValidRange(entities, signs, signedDistance);
  }

  _syncOffsetSelection() {
    const sketch = this.activeSketch(); if (!sketch) return;
    this._normalizeOffsetEntityIds();
    this.clearSelection();
    const ids = new Set(this.offsetEntityIds);
    for (const e of sketch.entities) {
      if (ids.has(e.id)) this.setSelected(e, true);
    }
    this.refreshUI();
    this.requestRender();
  }

  updateOffsetCursor(world) {
    if (this.operationName !== 'offset' || !world) return;
    const entity = this.offsetAnchorId ? this._lookupAny(this.offsetAnchorId) : null;
    if (!entity) return;
    const side = this._offsetCursorSide(entity, world);
    if (side != null) this.offsetSide = side;
    const d = this._offsetDistanceFromCursor(world);
    if (d != null) this.offsetDistance = d;
  }

  _curveGapEndpoints(a, b) {
    const dx = b.center.x - a.center.x;
    const dy = b.center.y - a.center.y;
    const d = Math.hypot(dx, dy);
    if (d < EPS) return null;
    const ux = dx / d, uy = dy / d;
    return {
      p1: { x: a.center.x + ux * a.r, y: a.center.y + uy * a.r },
      p2: { x: b.center.x - ux * b.r, y: b.center.y - uy * b.r },
      d
    };
  }

  _cursorSuggestsCurveGap(a, b, world) {
    if (!world) return false;
    const geom = this._curveGapEndpoints(a, b);
    if (!geom) return false;
    if (geom.d <= a.r + b.r + EPS) return false;
    const mid = { x: (geom.p1.x + geom.p2.x) / 2, y: (geom.p1.y + geom.p2.y) / 2 };
    const axisX = geom.p2.x - geom.p1.x;
    const axisY = geom.p2.y - geom.p1.y;
    const len = Math.hypot(axisX, axisY);
    if (len < EPS) return false;
    const nx = -axisY / len, ny = axisX / len;
    const tx = axisX / len, ty = axisY / len;
    const wx = world.x - mid.x, wy = world.y - mid.y;
    const perp = Math.abs(wx * nx + wy * ny);
    const along = Math.abs(wx * tx + wy * ty);
    return perp < (18 / this.app.view.zoom) && along < (24 / this.app.view.zoom);
  }

  _mirrorDataFromSelection() {
    const sketch = this.activeSketch(); if (!sketch) return { entityIds: [], axisId: null };
    const sel = this.selectedEntitiesAndPoints().filter(e => !(e instanceof Constraint));
    const selectedLines = sel.filter(e => e instanceof Line);
    const constructionAxes = selectedLines.filter(l => l.construction);
    const axis = constructionAxes.length === 1 ? constructionAxes[0] : null;
    const sources = this._mirrorSourcesFrom(sel, axis);
    return { entityIds: sources.map(e => e.id), axisId: axis?.id || null };
  }

  _mirrorSourcesFrom(sel, axis) {
    const sketch = this.activeSketch(); if (!sketch) return [];
    const selectedTop = new Set(sketch.entities.filter(e => (sel.includes(e) || e.selected) && e !== axis));
    const pointOwnedBySelectedEntity = (p) => {
      for (const e of selectedTop) {
        if (e === p) return true;
        for (const c of e.children()) if (c === p) return true;
      }
      return false;
    };
    const sources = [];
    for (const e of sketch.entities) {
      if (e !== axis && (sel.includes(e) || e.selected) && (e instanceof Point || e instanceof Line || e instanceof Circle)) sources.push(e);
    }
    for (const e of sel) {
      if (e instanceof Point && e !== axis && !pointOwnedBySelectedEntity(e) && !sources.includes(e)) sources.push(e);
    }
    return sources;
  }

  _mirrorOperationData() {
    const sketch = this.activeSketch(); if (!sketch) return null;
    const axis = this.mirrorAxisId ? sketch.entities.find(e => e instanceof Line && e.id === this.mirrorAxisId) : null;
    const sources = this.mirrorEntityIds
      .map(id => this._lookupAny(id))
      .filter(e => e && this.project.sketchOf(e) === sketch && e !== axis && (e instanceof Point || e instanceof Line || e instanceof Circle));
    return { axis, sources };
  }

  _syncMirrorSelection() {
    const sketch = this.activeSketch(); if (!sketch) return;
    this.clearSelection();
    const ids = new Set(this.mirrorEntityIds);
    if (this.mirrorAxisId) ids.add(this.mirrorAxisId);
    for (const e of sketch.entities) {
      if (ids.has(e.id)) this.setSelected(e, true);
      for (const c of e.children()) if (ids.has(c.id)) this.setSelected(c, true);
    }
    this.refreshUI();
    this.requestRender();
  }

  handleMirrorPick(hit) {
    if (this.operationName !== 'mirror') return false;
    if (!hit) return true;
    const sketch = this.activeSketch();
    if (!sketch || this.project.sketchOf(hit) !== sketch) return true;
    if (this.mirrorPickMode === 'axis') {
      if (!(hit instanceof Line)) return true;
      this.mirrorAxisId = hit.id;
      this.mirrorEntityIds = this.mirrorEntityIds.filter(id => id !== hit.id);
      this.mirrorPickMode = 'entities';
    } else {
      if (!(hit instanceof Point || hit instanceof Line || hit instanceof Circle)) return true;
      if (hit.id === this.mirrorAxisId) return true;
      const i = this.mirrorEntityIds.indexOf(hit.id);
      if (i >= 0) this.mirrorEntityIds.splice(i, 1);
      else this.mirrorEntityIds.push(hit.id);
    }
    this._syncMirrorSelection();
    return true;
  }

  handleMirrorBoxPick(hits, opts = {}) {
    if (this.operationName !== 'mirror' || this.mirrorPickMode !== 'entities') return false;
    const sketch = this.activeSketch();
    if (!sketch) return true;
    if (opts.replace) this.mirrorEntityIds = [];
    for (const hit of hits || []) {
      if (!(hit instanceof Point || hit instanceof Line || hit instanceof Circle)) continue;
      if (this.project.sketchOf(hit) !== sketch) continue;
      if (hit.id === this.mirrorAxisId) continue;
      const i = this.mirrorEntityIds.indexOf(hit.id);
      if (opts.toggle) {
        if (i >= 0) this.mirrorEntityIds.splice(i, 1);
        else this.mirrorEntityIds.push(hit.id);
      } else if (i < 0) {
        this.mirrorEntityIds.push(hit.id);
      }
    }
    this._syncMirrorSelection();
    return true;
  }

  handleOffsetPick(hit, world) {
    if (this.operationName !== 'offset') return false;
    if (this.offsetPhase === 'typing') return true;
    if (!hit) {
      if (this.offsetEntityIds.length) {
        this.offsetPhase = 'placing';
        this.updateOffsetCursor(world);
        this.refreshToolOptions();
      }
      return true;
    }
    if (!(hit instanceof Line || hit instanceof Circle || hit instanceof Arc)) return true;
    const sketch = this.activeSketch();
    if (!sketch || this.project.sketchOf(hit) !== sketch) return true;
    const i = this.offsetEntityIds.indexOf(hit.id);
    if (i >= 0) this.offsetEntityIds.splice(i, 1);
    else this.offsetEntityIds.push(hit.id);
    this.offsetAnchorId = this.offsetEntityIds.includes(hit.id) ? hit.id : (this.offsetEntityIds[0] || null);
    this.offsetPhase = this.offsetEntityIds.length ? 'placing' : 'selecting';
    this.updateOffsetCursor(world);
    this._syncOffsetSelection();
    return true;
  }

  _showOffsetInput() {
    if (this.offsetInputEl) { this.offsetInputEl.remove(); this.offsetInputEl = null; }
    const pos = this.view.worldToScreen(this.lastWorldCursor || { x:0, y:0 });
    const input = document.createElement('input');
    input.type = 'text';
    Object.assign(input.style, {
      position: 'absolute',
      left: pos.x + 'px',
      top: pos.y + 'px',
      transform: 'translate(-50%, -50%)',
      zIndex: '30',
      padding: '2px 5px',
      border: '1.5px solid var(--accent)',
      borderRadius: '3px',
      background: 'var(--field)', color: 'var(--text)', caretColor: 'var(--accent)',
      font: '12px ui-sans-serif, system-ui',
      width: '72px',
      textAlign: 'right',
      outline: 'none',
      boxShadow: '0 1px 4px rgba(0,0,0,0.25)'
    });
    input.value = Number(this.offsetDistance || 0).toFixed(3);
    document.getElementById('workspace').appendChild(input);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    this.offsetInputEl = input;
    this.offsetPhase = 'typing';
    const finish = (commit) => {
      if (!this.offsetInputEl) return;
      const raw = this.offsetInputEl.value;
      this.offsetInputEl.removeEventListener('keydown', onKey);
      this.offsetInputEl.removeEventListener('blur', onBlur);
      this.offsetInputEl.remove();
      this.offsetInputEl = null;
      if (commit) {
        let v = NaN;
        try { v = Math.abs(evaluate(raw, (n) => this._namedValue(n))); } catch { /* keep previous distance */ }
        if (Number.isFinite(v)) this.offsetDistance = v;
        this.offsetSelection();
      } else {
        this.offsetPhase = this.offsetEntityIds.length ? 'placing' : 'selecting';
        this.refreshToolOptions();
        this.requestRender();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else e.stopPropagation();
    };
    const onBlur = () => finish(true);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
    this.refreshToolOptions();
  }

  _refreshMirrorOptions(section, body) {
    const data = this._mirrorOperationData();
    section.hidden = false;
    document.getElementById('tool-options-title').textContent = 'Mirror';
    if (!data) {
      body.innerHTML = '<div class="empty">No active sketch.</div>';
      return;
    }
    const sources = data.sources;
    const axis = data.axis;
    const sourceHtml = sources.length
      ? `<div class="stack-list">${sources.map(e => `<div class="sel-item"><span class="glyph">${e instanceof Point ? 'P' : e instanceof Line ? 'L' : 'C'}</span><span>${this._entityLabel(e)}</span></div>`).join('')}</div>`
      : '<div class="tool-note">Click or drag a box in the canvas to collect source entities.</div>';
    const axisHtml = axis
      ? `<div class="stack-list"><div class="sel-item"><span class="glyph">L</span><span>${this._entityLabel(axis)}${axis.construction ? ' construction' : ''}</span></div></div>`
      : '<div class="tool-note">Pick one line to use as the mirror axis.</div>';
    const entitiesActive = this.mirrorPickMode === 'entities';
    const axisActive = this.mirrorPickMode === 'axis';
    document.getElementById('status-hint').textContent = entitiesActive
      ? 'Mirror: click or box-select points, lines, or circles to add/remove them.'
      : 'Mirror: click a line to set the mirror axis.';
    body.innerHTML = `
      <div class="tool-summary">
        <div class="tool-metric"><strong>${sources.length}</strong><span>Sources</span></div>
        <div class="tool-metric"><strong>${axis ? 'Set' : 'None'}</strong><span>Axis</span></div>
      </div>
      <div class="sb-subhead">Pick Mode</div>
      <button class="choice-row ${entitiesActive ? 'active' : ''}" id="mirror-pick-entities">
        <span class="glyph">${entitiesActive ? '>' : '+'}</span>
        <span><strong>Entities</strong><span>Click or box-select points, lines, or circles.</span></span>
      </button>
      <button class="choice-row ${axisActive ? 'active' : ''}" id="mirror-pick-axis">
        <span class="glyph">${axisActive ? '>' : '+'}</span>
        <span><strong>Axis</strong><span>Click a line to define the reflection axis.</span></span>
      </button>
      <div class="sb-subhead">Sources</div>
      ${sourceHtml}
      <div class="sb-subhead">Mirror Axis</div>
      ${axisHtml}
      <div class="rel-grid op-actions">
        <button class="rel-btn primary" id="mirror-create" ${(!axis || !sources.length) ? 'disabled' : ''}>${uiIcon('mirror')}Create</button>
        <button class="rel-btn danger" id="mirror-cancel">${uiIcon('x')}Cancel</button>
      </div>
    `;
    body.querySelector('#mirror-pick-entities')?.addEventListener('click', () => {
      this.mirrorPickMode = 'entities';
      this.refreshToolOptions();
    });
    body.querySelector('#mirror-pick-axis')?.addEventListener('click', () => {
      this.mirrorPickMode = 'axis';
      this.refreshToolOptions();
    });
    body.querySelector('#mirror-create')?.addEventListener('click', () => this.mirrorSelection());
    body.querySelector('#mirror-cancel')?.addEventListener('click', () => {
      this.cancelOperation();
    });
  }

  _refreshOffsetOptions(section, body) {
    section.hidden = false;
    document.getElementById('tool-options-title').textContent = 'Offset';
    const entities = this._offsetEntities();
    const topologyIssue = this._offsetTopologyIssue(entities);
    const preview = this._offsetPreviewData();
    document.getElementById('status-hint').textContent =
      this.offsetPhase === 'typing'
        ? 'Offset: type a value, Enter to create, Esc to cancel.'
        : entities.length
        ? 'Offset: move the mouse to place. Click in space to type a value, or use Create below.'
        : 'Offset: click one or more lines, circles, or arcs to select them.';
    const entityHtml = entities.length
      ? `<div class="stack-list">${entities.map(entity => `<div class="sel-item"><span class="glyph">${entity instanceof Line ? 'L' : entity instanceof Circle ? 'C' : 'A'}</span><span>${this._entityLabel(entity)}${entity.id === this.offsetAnchorId ? ' anchor' : ''}</span></div>`).join('')}</div>`
      : '<div class="tool-note">Click lines, circles, arcs, or box-select a path to offset.</div>';
    body.innerHTML = `
      <div class="tool-summary">
        <div class="tool-metric"><strong>${entities.length}</strong><span>Entities</span></div>
        <div class="tool-metric"><strong>${this.offsetSide > 0 ? 'A' : 'B'}</strong><span>Side</span></div>
      </div>
      <div class="sb-subhead">Offset Entities</div>
      ${entityHtml}
      <div class="prop-row">
        <label for="offset-distance">distance</label>
        <input id="offset-distance" type="number" min="0" step="0.1" value="${Number(this.offsetDistance) || 0}">
      </div>
      <div class="prop-row">
        <label>side</label>
        <button class="rel-btn" id="offset-flip" ${entities.length ? '' : 'disabled'}>${uiIcon('flip')}Flip side</button>
      </div>
      ${topologyIssue ? `<div class="tool-note warn">${topologyIssue}</div>` : ''}
      ${entities.length && !topologyIssue && !preview ? '<div class="tool-note warn">Offset distance is invalid for one or more selected entities.</div>' : ''}
      <div class="rel-grid op-actions">
        <button class="rel-btn primary" id="offset-create" ${(!entities.length || topologyIssue || !preview) ? 'disabled' : ''}>${uiIcon('plus')}Create</button>
        <button class="rel-btn danger" id="offset-cancel">${uiIcon('x')}Cancel</button>
      </div>
    `;
    const input = body.querySelector('#offset-distance');
    input?.addEventListener('input', () => {
      const n = Math.abs(parseFloat(input.value));
      this.offsetDistance = Number.isFinite(n) ? n : 0;
      this.refreshToolOptions();
      this.requestRender();
    });
    body.querySelector('#offset-flip')?.addEventListener('click', () => {
      this.offsetSide *= -1;
      this.refreshToolOptions();
      this.requestRender();
    });
    body.querySelector('#offset-create')?.addEventListener('click', () => this.offsetSelection());
    body.querySelector('#offset-cancel')?.addEventListener('click', () => {
      this.cancelOperation();
    });
  }

  mirrorSelection() {
    const sketch = this.activeSketch(); if (!sketch) return;
    const data = this._mirrorOperationData();
    const axis = data?.axis;
    const sources = data?.sources || [];
    if (!axis) {
      alert('Select a mirror axis.');
      return;
    }
    if (!sources.length) {
      alert('Select at least one point, line, or circle in addition to the mirror axis.');
      return;
    }

    const pointMap = new Map();
    const linkedPoints = new Set();
    const newEntities = [];
    const axisRef = { a: axis.p1.id, b: axis.p2.id };
    const mirroredPoint = (p) => {
      if (pointMap.has(p)) return pointMap.get(p);
      const mp = mirrorPointAcrossLine(p, axis);
      const q = new Point(mp.x, mp.y);
      pointMap.set(p, q);
      return q;
    };
    const linkPoint = (p) => {
      const q = mirroredPoint(p);
      if (!linkedPoints.has(p.id)) {
        sketch.constraints.push(new SymmetricConstraint(p.id, q.id, axisRef, 'p1'));
        linkedPoints.add(p.id);
      }
      return q;
    };

    for (const src of sources) {
      if (src instanceof Point) {
        const p = linkPoint(src);
        copyDisplay(src, p);
        sketch.addEntity(p);
        newEntities.push(p);
      } else if (src instanceof Line) {
        const a = linkPoint(src.p1);
        const b = linkPoint(src.p2);
        const line = new Line(a, b);
        line.construction = src.construction;
        copyDisplay(src, line);
        sketch.addEntity(line);
        newEntities.push(line);
      } else if (src instanceof Circle) {
        const center = linkPoint(src.center);
        const circle = new Circle(center, src.r);
        circle.construction = src.construction;
        copyDisplay(src, circle);
        sketch.addEntity(circle);
        sketch.constraints.push(new EqualRadiusConstraint(src.id, circle.id));
        newEntities.push(circle);
      }
    }

    if (!newEntities.length) return;
    this.clearSelection();
    for (const e of newEntities) this.setSelected(e, true);
    this.operationName = null;
    this.mirrorPickMode = 'entities';
    this.mirrorEntityIds = [];
    this.mirrorAxisId = null;
    document.getElementById('status-hint').textContent = (this.tool.hint && this.tool.hint()) || '';
    this.commit();
    this.refreshUI();
  }

  getMirrorPreview() {
    if (this.operationName !== 'mirror') return null;
    const data = this._mirrorOperationData();
    const axis = data?.axis;
    const sources = data?.sources || [];
    if (!axis || !sources.length) return null;
    const pointMap = new Map();
    const mirroredPoint = (p) => {
      if (pointMap.has(p)) return pointMap.get(p);
      const q = mirrorPointAcrossLine(p, axis);
      pointMap.set(p, q);
      return q;
    };
    const paths = [];
    const points = [];
    const circles = [];
    for (const src of sources) {
      if (src instanceof Point) {
        points.push(mirroredPoint(src));
      } else if (src instanceof Line) {
        paths.push([mirroredPoint(src.p1), mirroredPoint(src.p2)]);
      } else if (src instanceof Circle) {
        circles.push({ center: mirroredPoint(src.center), r: src.r });
      }
    }
    return { paths, points, circles, dashed: true };
  }

  _mapOffsetEntityIds(source, target, idMap) {
    if (!source || !target) return;
    idMap.set(source.id, target.id);
    const sourceChildren = source.children ? source.children() : [];
    const targetChildren = target.children ? target.children() : [];
    for (let i = 0; i < sourceChildren.length && i < targetChildren.length; i++) {
      idMap.set(sourceChildren[i].id, targetChildren[i].id);
    }
  }

  _cloneOffsetGroupConstraint(c, idMap) {
    if (!c || !c.refs().every(id => idMap.has(id))) return null;

    const mid = (id) => idMap.get(id);
    const lineRef = (l) => l ? { a: mid(l.a), b: mid(l.b) } : null;
    const arcRef = (r) => r ? { arcId: mid(r.arcId), centerId: mid(r.centerId), which: r.which } : null;
    const pointRef = (r) => r?.pointId ? { pointId: mid(r.pointId) } : arcRef(r);
    const copyMeta = (clone) => {
      if (!clone) return null;
      for (const key of ['labelOffset', 'labelParallel', 'labelAngle', 'labelDist', 'labelMidAngle']) {
        if (c[key] != null) clone[key] = c[key];
      }
      if (c.sourceSide) clone.sourceSide = c.sourceSide;
      if (c.axis) clone.axis = c.axis;
      if (c.driven) clone.driven = true;
      if (c.isDiameter) clone.isDiameter = true;
      return clone;
    };

    let clone = null;
    switch (c.kind) {
      case 'coincident':
        clone = new CoincidentConstraint(mid(c.p1), mid(c.p2));
        break;
      case 'horizontal':
        clone = new HorizontalConstraint(mid(c.lineId), mid(c.p1), mid(c.p2));
        break;
      case 'vertical':
        clone = new VerticalConstraint(mid(c.lineId), mid(c.p1), mid(c.p2));
        break;
      case 'pointRefHorizontal':
        clone = new PointRefHorizontalConstraint(pointRef(c.ref1), pointRef(c.ref2));
        break;
      case 'pointRefVertical':
        clone = new PointRefVerticalConstraint(pointRef(c.ref1), pointRef(c.ref2));
        break;
      case 'symmetric':
        clone = new SymmetricConstraint(mid(c.p1), mid(c.p2), lineRef(c.axis));
        break;
      case 'parallel':
        clone = new ParallelConstraint(lineRef(c.l1), lineRef(c.l2));
        break;
      case 'perpendicular':
        clone = new PerpendicularConstraint(lineRef(c.l1), lineRef(c.l2));
        break;
      case 'collinear':
        clone = new CollinearConstraint(lineRef(c.l1), lineRef(c.l2));
        break;
      case 'equalLength':
        clone = new EqualLengthConstraint(lineRef(c.l1), lineRef(c.l2));
        break;
      case 'equalRadius':
        clone = new EqualRadiusConstraint(mid(c.c1), mid(c.c2));
        break;
      case 'concentric':
        clone = new ConcentricConstraint(mid(c.p1), mid(c.p2));
        break;
      case 'tangent':
        clone = c.c1 != null
          ? new TangentCircleCircleConstraint(mid(c.c1), mid(c.p1), mid(c.c2), mid(c.p2), !!c.internal)
          : new TangentLineCircleConstraint(lineRef(c.l), mid(c.circleId), mid(c.centerId));
        break;
      case 'midpoint':
        clone = new MidpointConstraint(mid(c.pointId), lineRef(c.l));
        break;
      case 'angle':
        clone = new AngleConstraint(lineRef(c.l1), lineRef(c.l2), c.value);
        break;
      case 'directedAngle':
        clone = new DirectedAngleConstraint(lineRef(c.l1), lineRef(c.l2), c.value);
        break;
      case 'pointOnLine':
        clone = new PointOnLineConstraint(mid(c.pointId), lineRef(c.l));
        break;
      case 'pointOnCircle':
        clone = new PointOnCircleConstraint(mid(c.pointId), mid(c.circleId), mid(c.centerId));
        break;
      case 'arcEndpointCoincident':
        clone = new ArcEndpointCoincidentConstraint(arcRef(c.ref), mid(c.pointId));
        break;
      case 'arcEndpointArcEndpointCoincident':
        clone = new ArcEndpointArcEndpointCoincidentConstraint(arcRef(c.ref1), arcRef(c.ref2));
        break;
      case 'arcEndpointMidpoint':
        clone = new ArcEndpointMidpointConstraint(arcRef(c.ref), lineRef(c.l));
        break;
      case 'arcEndpointOnLine':
        clone = new ArcEndpointOnLineConstraint(arcRef(c.ref), lineRef(c.l));
        break;
      case 'arcEndpointOnCircle':
        clone = new ArcEndpointOnCircleConstraint(arcRef(c.ref), mid(c.circleId), mid(c.centerId));
        break;
      case 'offset':
        clone = new OffsetConstraint(
          mid(c.sourceEntityId), mid(c.targetEntityId), c.offsetKind,
          c.offsetKind === 'line'
            ? { l1: lineRef(c.l1), l2: lineRef(c.l2) }
            : { p1: mid(c.p1), p2: mid(c.p2) }
        );
        break;
    }
    return copyMeta(clone);
  }

  _offsetGroupConstraintClones(sketch, idMap) {
    const clones = [];
    for (const c of sketch.constraints) {
      if (!this._isOffsetTransferableConstraint(c, idMap)) continue;
      const clone = this._cloneOffsetGroupConstraint(c, idMap);
      if (!clone) continue;
      if (this._isInvalidConstraint(sketch, clone)) continue;
      if (this._isDuplicateConstraint(sketch, clone)) continue;
      clones.push(clone);
    }
    return clones;
  }

  _isOffsetTransferableConstraint(c, idMap) {
    if (!c || !c.refs().every(id => idMap.has(id))) return false;

    // Offset is a derived feature, not a raw copy. Most source constraints
    // either already flow through source->target offset constraints
    // (horizontal, vertical, equal lengths, central angles) or are build
    // scaffolding (midpoints on construction centerlines). Copying them
    // over-constrains generated geometry. Transfer only constraints whose
    // geometric meaning remains true after offsetting both referenced shapes.
    switch (c.kind) {
      case 'pointOnCircle':
        return true;
      case 'arcEndpointOnCircle':
        return true;
      case 'concentric':
        return true;
      default:
        return false;
    }
  }

  _offsetSourcesWithInternalCirclePointConstraints(sketch, sourceIds) {
    const blocked = new Set();
    for (const c of sketch.constraints) {
      if (c.kind === 'pointOnCircle' && sourceIds.has(c.pointId) && sourceIds.has(c.circleId) && sourceIds.has(c.centerId)) {
        blocked.add(c.circleId);
      } else if (c.kind === 'arcEndpointOnCircle'
          && sourceIds.has(c.ref.arcId) && sourceIds.has(c.ref.centerId)
          && sourceIds.has(c.circleId) && sourceIds.has(c.centerId)) {
        blocked.add(c.circleId);
      }
    }
    return blocked;
  }

  offsetSelection() {
    const sketch = this.activeSketch(); if (!sketch) return;
    const preview = this._offsetPreviewData();
    const entities = this._offsetEntities();
    if (!entities.length) {
      alert('Select one or more lines, circles, or arcs to offset.');
      return;
    }
    const topologyIssue = this._offsetTopologyIssue(entities);
    if (topologyIssue) {
      alert(topologyIssue);
      return;
    }
    if (!preview) {
      alert('Offset distance is invalid for one or more selected entities.');
      return;
    }

    const made = [];
    const madeBySourceId = new Map();
    const sourceToTargetId = new Map();
    const pointMap = new Map();
    const getPoint = (p) => {
      if (!p) return null;
      if (pointMap.has(p)) return pointMap.get(p);
      const q = new Point(p.x, p.y);
      pointMap.set(p, q);
      return q;
    };
    for (const item of preview.items) {
      let entity = null;
      if (item.kind === 'line') {
        entity = new Line(getPoint(item.p1), getPoint(item.p2));
      } else if (item.kind === 'circle') {
        entity = new Circle(new Point(item.center.x, item.center.y), item.r);
      } else if (item.kind === 'arc') {
        entity = new Arc(new Point(item.center.x, item.center.y), item.r, item.a0, item.a1);
        entity.clockwise = !!item.clockwise;
        entity.syncEnds();
      }
      if (!entity) continue;
      entity.construction = item.source.construction;
      copyDisplay(item.source, entity);
      sketch.addEntity(entity);
      made.push(entity);
      madeBySourceId.set(item.source.id, { source: item.source, entity, item });
      this._mapOffsetEntityIds(item.source, entity, sourceToTargetId);
    }
    const constrainedCircleSources = this._offsetSourcesWithInternalCirclePointConstraints(
      sketch,
      new Set(sourceToTargetId.keys())
    );
    const clonedConstraints = this._offsetGroupConstraintClones(sketch, sourceToTargetId);
    const distPairs = [];
    for (const { source, entity, item } of madeBySourceId.values()) {
      if (source instanceof Line && entity instanceof Line) {
        sketch.constraints.push(new OffsetConstraint(
          source.id, entity.id, 'line',
          { l1: { a: source.p1.id, b: source.p2.id },
            l2: { a: entity.p1.id, b: entity.p2.id } }
        ));
        distPairs.push({ kind: 'line', pointId: entity.p1.id,
          l: { a: source.p1.id, b: source.p2.id },
          sourceEntityId: source.id,
          targetEntityId: entity.id,
          value: item.offsetValue });
      } else if ((source instanceof Circle || source instanceof Arc) && (entity instanceof Circle || entity instanceof Arc)) {
        sketch.constraints.push(new OffsetConstraint(
          source.id, entity.id, 'circle',
          { p1: source.center.id, p2: entity.center.id }
        ));
        if (!constrainedCircleSources.has(source.id)) {
          distPairs.push({ kind: 'circle', c1: entity.id, c2: source.id, value: item.offsetValue });
        }
        if (source instanceof Arc && entity instanceof Arc) {
          sketch.constraints.push(new ParamFixConstraint(entity.id, 'a0', entity.a0));
          sketch.constraints.push(new ParamFixConstraint(entity.id, 'a1', entity.a1));
        }
      }
    }
    for (const c of clonedConstraints) sketch.constraints.push(c);
    if (distPairs.length > 0) {
      sketch.constraints.push(new OffsetDistanceConstraint(distPairs, Math.abs(preview.items[0].offsetValue)));
    }
    if (!made.length) return;
    sketch.features.push({
      id:newId('f'),
      kind:'offset',
      sourceEntityIds:[...madeBySourceId.values()].map(v => v.source.id),
      generatedEntityIds:made.map(e => e.id),
      distance:Math.abs(preview.items[0].offsetValue),
      policy:'derived',
      transferredConstraintKinds:[...new Set(clonedConstraints.map(c => c.kind))]
    });

    this.clearSelection();
    for (const entity of made) this.setSelected(entity, true);
    this._clearOperationState();
    document.getElementById('status-hint').textContent = (this.tool.hint && this.tool.hint()) || '';
    this.commit();
    this.refreshUI();
  }

  getOffsetPreview() {
    if (this.operationName !== 'offset') return null;
    const preview = this._offsetPreviewData();
    if (!preview) return null;
    const paths = [], circles = [], arcs = [];
    for (const item of preview.items) {
      if (item.kind === 'line') paths.push([item.p1, item.p2]);
      else if (item.kind === 'circle') circles.push({ center: item.center, r: item.r });
      else if (item.kind === 'arc') arcs.push({ center: item.center, r: item.r, a0: item.a0, a1: item.a1, clockwise: item.clockwise });
    }
    return { paths, circles, arcs, dashed: true };
  }
}

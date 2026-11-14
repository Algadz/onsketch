import { EPS, TAU, normalizeAngleValue } from './math.js';
import { newId } from './entities.js';
import { bezierAt, bezierNearest, bezierTangent } from './bezier.js';

/* =============== 3. CONSTRAINTS =============================== */
export class Constraint {
  constructor(kind) { this.id = newId('c'); this.kind = kind; this.value = null; this.selected = false; }
  residuals(L) { return []; }
  refs() { return []; }
  toJSON() { return { id:this.id, kind:this.kind, value:this.value, refs:this.refs() }; }
}

export class FixConstraint extends Constraint {
  constructor(pointId, x, y) { super('fix'); this.pointId=pointId; this.x=x; this.y=y; }
  refs() { return [this.pointId]; }
  residuals(L) { return [ L(this.pointId,'x') - this.x, L(this.pointId,'y') - this.y ]; }
  toJSON() { return { id:this.id, kind:'fix', pointId:this.pointId, x:this.x, y:this.y }; }
}

export class ParamFixConstraint extends Constraint {
  constructor(entityId, key, value) {
    super('paramFix');
    this.entityId = entityId;
    this.key = key;
    this.value = value;
  }
  refs() { return [this.entityId]; }
  residuals(L) { return [ L(this.entityId, this.key) - this.value ]; }
  toJSON() { return { id:this.id, kind:'paramFix', entityId:this.entityId, key:this.key, value:this.value }; }
}

export class CoincidentConstraint extends Constraint {
  constructor(p1Id, p2Id) { super('coincident'); this.p1=p1Id; this.p2=p2Id; }
  refs() { return [this.p1, this.p2]; }
  residuals(L) { return [ L(this.p1,'x')-L(this.p2,'x'), L(this.p1,'y')-L(this.p2,'y') ]; }
  toJSON() { return { id:this.id, kind:'coincident', p1:this.p1, p2:this.p2 }; }
}

export class HorizontalConstraint extends Constraint {
  constructor(lineId, p1Id, p2Id) { super('horizontal'); this.lineId=lineId; this.p1=p1Id; this.p2=p2Id; }
  refs() { return [this.lineId, this.p1, this.p2]; }
  residuals(L) { return [ L(this.p1,'y') - L(this.p2,'y') ]; }
  toJSON() { return { id:this.id, kind:'horizontal', lineId:this.lineId, p1:this.p1, p2:this.p2 }; }
}

export class VerticalConstraint extends Constraint {
  constructor(lineId, p1Id, p2Id) { super('vertical'); this.lineId=lineId; this.p1=p1Id; this.p2=p2Id; }
  refs() { return [this.lineId, this.p1, this.p2]; }
  residuals(L) { return [ L(this.p1,'x') - L(this.p2,'x') ]; }
  toJSON() { return { id:this.id, kind:'vertical', lineId:this.lineId, p1:this.p1, p2:this.p2 }; }
}

export class SymmetricConstraint extends Constraint {
  constructor(p1Id, p2Id, axis, sourceSide = null) {
    super('symmetric');
    this.p1 = p1Id;
    this.p2 = p2Id;
    this.axis = axis;
    this.sourceSide = sourceSide;
  }
  refs() { return [this.p1, this.p2, this.axis.a, this.axis.b]; }
  residuals(L) {
    const ax=L(this.axis.a,'x'), ay=L(this.axis.a,'y');
    const bx=L(this.axis.b,'x'), by=L(this.axis.b,'y');
    const px=L(this.p1,'x'), py=L(this.p1,'y');
    const qx=L(this.p2,'x'), qy=L(this.p2,'y');
    const dx=bx-ax, dy=by-ay;
    const len = Math.hypot(dx, dy);
    if (len < EPS) return [0, 0];
    const mx = (px + qx) / 2, my = (py + qy) / 2;
    return [
      (dx*(my-ay) - dy*(mx-ax)) / len,
      (dx*(qx-px) + dy*(qy-py)) / len
    ];
  }
  toJSON() {
    const o = { id:this.id, kind:'symmetric', p1:this.p1, p2:this.p2, axis:this.axis };
    if (this.sourceSide) o.sourceSide = this.sourceSide;
    return o;
  }
}

export class ParallelConstraint extends Constraint {
  constructor(l1Pts, l2Pts) { super('parallel'); this.l1=l1Pts; this.l2=l2Pts; }
  refs() { return [this.l1.a, this.l1.b, this.l2.a, this.l2.b]; }
  residuals(L) {
    const dx1=L(this.l1.b,'x')-L(this.l1.a,'x'), dy1=L(this.l1.b,'y')-L(this.l1.a,'y');
    const dx2=L(this.l2.b,'x')-L(this.l2.a,'x'), dy2=L(this.l2.b,'y')-L(this.l2.a,'y');
    return [ dx1*dy2 - dy1*dx2 ];
  }
  toJSON() { return { id:this.id, kind:'parallel', l1:this.l1, l2:this.l2 }; }
}

export class PerpendicularConstraint extends Constraint {
  constructor(l1Pts, l2Pts) { super('perpendicular'); this.l1=l1Pts; this.l2=l2Pts; }
  refs() { return [this.l1.a, this.l1.b, this.l2.a, this.l2.b]; }
  residuals(L) {
    const dx1=L(this.l1.b,'x')-L(this.l1.a,'x'), dy1=L(this.l1.b,'y')-L(this.l1.a,'y');
    const dx2=L(this.l2.b,'x')-L(this.l2.a,'x'), dy2=L(this.l2.b,'y')-L(this.l2.a,'y');
    return [ dx1*dx2 + dy1*dy2 ];
  }
  toJSON() { return { id:this.id, kind:'perpendicular', l1:this.l1, l2:this.l2 }; }
}

export class CollinearConstraint extends Constraint {
  /** Two lines lie on the same infinite line: parallel + one endpoint of l2 on l1's line. */
  constructor(l1Pts, l2Pts) { super('collinear'); this.l1=l1Pts; this.l2=l2Pts; }
  refs() { return [this.l1.a, this.l1.b, this.l2.a, this.l2.b]; }
  residuals(L) {
    const ax=L(this.l1.a,'x'), ay=L(this.l1.a,'y');
    const bx=L(this.l1.b,'x'), by=L(this.l1.b,'y');
    const cx=L(this.l2.a,'x'), cy=L(this.l2.a,'y');
    const dx=L(this.l2.b,'x'), dy=L(this.l2.b,'y');
    // both endpoints of l2 lie on the line through l1
    const v = (px, py) => (bx-ax)*(py-ay) - (by-ay)*(px-ax);
    return [ v(cx, cy), v(dx, dy) ];
  }
  toJSON() { return { id:this.id, kind:'collinear', l1:this.l1, l2:this.l2 }; }
}

export class EqualLengthConstraint extends Constraint {
  constructor(l1Pts, l2Pts) { super('equalLength'); this.l1=l1Pts; this.l2=l2Pts; }
  refs() { return [this.l1.a, this.l1.b, this.l2.a, this.l2.b]; }
  residuals(L) {
    if (this.driven) return [];
    const dx1=L(this.l1.b,'x')-L(this.l1.a,'x'), dy1=L(this.l1.b,'y')-L(this.l1.a,'y');
    const dx2=L(this.l2.b,'x')-L(this.l2.a,'x'), dy2=L(this.l2.b,'y')-L(this.l2.a,'y');
    return [ Math.sqrt(dx1*dx1+dy1*dy1) - Math.sqrt(dx2*dx2+dy2*dy2) ];
  }
  toJSON() {
    const o = { id:this.id, kind:'equalLength', l1:this.l1, l2:this.l2 };
    if (this.driven) o.driven = true;
    return o;
  }
}

export class EqualRadiusConstraint extends Constraint {
  constructor(c1Id, c2Id) { super('equalRadius'); this.c1=c1Id; this.c2=c2Id; }
  refs() { return [this.c1, this.c2]; }
  residuals(L) { return [ L(this.c1,'r') - L(this.c2,'r') ]; }
  toJSON() { return { id:this.id, kind:'equalRadius', c1:this.c1, c2:this.c2 }; }
}

export class ConcentricConstraint extends Constraint {
  /** Two circles/arcs share a center. We hold both center points coincident. */
  constructor(c1CenterId, c2CenterId) { super('concentric'); this.p1=c1CenterId; this.p2=c2CenterId; }
  refs() { return [this.p1, this.p2]; }
  residuals(L) { return [ L(this.p1,'x')-L(this.p2,'x'), L(this.p1,'y')-L(this.p2,'y') ]; }
  toJSON() { return { id:this.id, kind:'concentric', p1:this.p1, p2:this.p2 }; }
}

export class TangentLineCircleConstraint extends Constraint {
  /** The line touches the circle (or arc): the distance from the centre
   *  to the line equals the radius.
   *
   *  When one end of the line is itself held on the circle (a tangent
   *  drawn from a point of the circle, a slot's straight side), that
   *  distance peaks exactly at tangency: it has no slope there, and the
   *  solver used to stall a hair away and report the sketch over-defined.
   *  Then `at` (set by the solver, see markTangentContacts) names that
   *  end, and the line is held perpendicular to the radius there instead:
   *  the same shapes, with a slope the solver can follow. */
  constructor(l, circleId, centerId) { super('tangent'); this.l=l; this.circleId=circleId; this.centerId=centerId; this.at=null; }
  refs() { return [this.l.a, this.l.b, this.circleId, this.centerId]; }
  residuals(L) {
    const ax=L(this.l.a,'x'), ay=L(this.l.a,'y');
    const bx=L(this.l.b,'x'), by=L(this.l.b,'y');
    const cx=L(this.centerId,'x'), cy=L(this.centerId,'y');
    const dx=bx-ax, dy=by-ay;
    const len = Math.hypot(dx, dy);
    if (len < EPS) return [0];
    if (this.at) {
      const px=L(this.at,'x'), py=L(this.at,'y');
      return [ ((px-cx)*dx + (py-cy)*dy) / len ];
    }
    const r=L(this.circleId,'r');
    const cross = dx*(cy-ay) - dy*(cx-ax);
    return [ Math.abs(cross) / len - r ];
  }
  toJSON() { return { id:this.id, kind:'tangent', l:this.l, circleId:this.circleId, centerId:this.centerId }; }
}

/** Before a solve: for each line–circle tangent, the end of the line that
 *  another constraint holds on that circle or arc, if any (see
 *  TangentLineCircleConstraint); with a lookup `L`, each constraint's
 *  prepare(L) (angles pick their side). */
export function markTangentContacts(constraints, L = null) {
  if (L) for (const c of constraints) if (c.prepare) c.prepare(L);
  const on = new Set();
  for (const c of constraints) {
    if (c.kind === 'pointOnCircle') on.add(c.pointId + '|' + c.circleId);
    else if (c.kind === 'arcEndpointCoincident') on.add(c.pointId + '|' + c.ref.arcId);
  }
  for (const c of constraints) {
    if (!(c instanceof TangentLineCircleConstraint)) continue;
    c.at = on.has(c.l.a + '|' + c.circleId) ? c.l.a : on.has(c.l.b + '|' + c.circleId) ? c.l.b : null;
  }
}

export class TangentCircleCircleConstraint extends Constraint {
  /** External tangent: distance between centers == r1 + r2. */
  constructor(c1Id, c1CenterId, c2Id, c2CenterId, internal=false) {
    super('tangent');
    this.c1=c1Id; this.p1=c1CenterId; this.c2=c2Id; this.p2=c2CenterId; this.internal=internal;
  }
  refs() { return [this.c1, this.p1, this.c2, this.p2]; }
  residuals(L) {
    const dx=L(this.p1,'x')-L(this.p2,'x'), dy=L(this.p1,'y')-L(this.p2,'y');
    const r1=L(this.c1,'r'), r2=L(this.c2,'r');
    const target = this.internal ? Math.abs(r1 - r2) : (r1 + r2);
    return [ Math.sqrt(dx*dx+dy*dy) - target ];
  }
  toJSON() { return { id:this.id, kind:'tangentCC', c1:this.c1, p1:this.p1, c2:this.c2, p2:this.p2, internal:this.internal }; }
}

export class MidpointConstraint extends Constraint {
  /** A point sits at the midpoint of a line. */
  constructor(pointId, l) { super('midpoint'); this.pointId=pointId; this.l=l; }
  refs() { return [this.pointId, this.l.a, this.l.b]; }
  residuals(L) {
    return [
      2*L(this.pointId,'x') - L(this.l.a,'x') - L(this.l.b,'x'),
      2*L(this.pointId,'y') - L(this.l.a,'y') - L(this.l.b,'y')
    ];
  }
  toJSON() { return { id:this.id, kind:'midpoint', pointId:this.pointId, l:this.l }; }
}

/** Frame of a distance dimension between p1 and p2, shared by the
 *  renderer, the Smart Dimension tool and label dragging.
 *  axis null: aligned (the true length); 'x': horizontal distance;
 *  'y': vertical distance. Returns the unit direction t along which the
 *  value is measured, the normal n the label is offset along, the two
 *  base points a0 / b0 the extension lines start from the dimension line
 *  at (before the offset), their midpoint, and the measured length. */
export function distanceFrame(p1, p2, axis = null) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  if (axis === 'x' || axis === 'y') {
    const along = axis === 'x' ? dx : dy;
    const s = along < 0 ? -1 : 1;
    const t = axis === 'x' ? { x: s, y: 0 } : { x: 0, y: s };
    const n = { x: -t.y, y: t.x };
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    // both ends projected onto the line through the midpoint, along the axis
    const a0 = axis === 'x' ? { x: p1.x, y: mid.y } : { x: mid.x, y: p1.y };
    const b0 = axis === 'x' ? { x: p2.x, y: mid.y } : { x: mid.x, y: p2.y };
    return { t, n, a0, b0, mid, len: Math.abs(along) };
  }
  const len = Math.hypot(dx, dy) || 1;
  const t = { x: dx / len, y: dy / len };
  return { t, n: { x: -t.y, y: t.x }, a0: p1, b0: p2, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, len: Math.hypot(dx, dy) };
}

export class DistanceConstraint extends Constraint {
  /** axis: null = aligned (true length), 'x' = horizontal distance,
   *  'y' = vertical distance (SolidWorks-style linear dimensions). */
  constructor(p1Id, p2Id, value, axis = null) {
    super('distance'); this.p1=p1Id; this.p2=p2Id; this.value=value;
    this.axis = axis === 'x' || axis === 'y' ? axis : null;
    this.labelOffset=null; this.labelParallel=null; this.driven=false;
  }
  refs() { return [this.p1, this.p2]; }
  residuals(L) {
    if (this.driven) return [];
    const dx=L(this.p1,'x')-L(this.p2,'x'), dy=L(this.p1,'y')-L(this.p2,'y');
    if (this.axis === 'x') return [ Math.abs(dx) - this.value ];
    if (this.axis === 'y') return [ Math.abs(dy) - this.value ];
    return [ Math.sqrt(dx*dx+dy*dy) - this.value ];
  }
  toJSON() {
    const o = { id:this.id, kind:'distance', p1:this.p1, p2:this.p2, value:this.value };
    if (this.axis) o.axis = this.axis;
    if (this.labelOffset   != null) o.labelOffset   = this.labelOffset;
    if (this.labelParallel != null) o.labelParallel = this.labelParallel;
    if (this.driven) o.driven = true;
    return o;
  }
}

export class PointLineDistanceConstraint extends Constraint {
  /** Perpendicular distance from a point to the infinite line through (a,b). */
  constructor(pointId, l, value) {
    super('pointLineDistance'); this.pointId=pointId; this.l=l; this.value=value;
    this.labelOffset=null; this.labelParallel=null; this.driven=false;
  }
  refs() { return [this.pointId, this.l.a, this.l.b]; }
  residuals(L) {
    if (this.driven) return [];
    const px=L(this.pointId,'x'), py=L(this.pointId,'y');
    const ax=L(this.l.a,'x'),     ay=L(this.l.a,'y');
    const bx=L(this.l.b,'x'),     by=L(this.l.b,'y');
    const dx=bx-ax, dy=by-ay;
    const cross = dx*(py-ay) - dy*(px-ax);
    const len = Math.sqrt(dx*dx + dy*dy);
    // In length units, like every other dimension, so the solver's absolute
    // tolerances mean the same thing at any drawing size. (The squared form
    // cross² − v²·len² grows with len⁴ and reads as "not solved" for
    // metre-sized drawings in mm.) Signed for 0, so "on the line" stays smooth.
    if (len < 1e-12) return [ Math.hypot(px-ax, py-ay) - this.value ];
    return [ this.value === 0 ? cross / len : Math.abs(cross) / len - this.value ];
  }
  toJSON() {
    const o = { id:this.id, kind:'pointLineDistance', pointId:this.pointId, l:this.l, value:this.value };
    if (this.labelOffset   != null) o.labelOffset   = this.labelOffset;
    if (this.labelParallel != null) o.labelParallel = this.labelParallel;
    if (this.driven) o.driven = true;
    return o;
  }
}

export class RadiusConstraint extends Constraint {
  constructor(circleId, value) {
    super('radius'); this.circleId=circleId; this.value=value;
    this.labelAngle=null; this.labelDist=null;     // labelDist: distance from center, controls inside/outside
    this.isDiameter=false; this.driven=false;
  }
  refs() { return [this.circleId]; }
  residuals(L) {
    if (this.driven) return [];
    return [ L(this.circleId,'r') - this.value ];
  }
  toJSON() {
    const o = { id:this.id, kind:'radius', circleId:this.circleId, value:this.value };
    if (this.labelAngle != null) o.labelAngle = this.labelAngle;
    if (this.labelDist  != null) o.labelDist  = this.labelDist;
    if (this.isDiameter) o.isDiameter = true;
    if (this.driven) o.driven = true;
    return o;
  }
}

export class CurveDistanceConstraint extends Constraint {
  constructor(c1Id, c2Id, mode, value) {
    super('curveDistance');
    this.c1 = c1Id;
    this.c2 = c2Id;
    this.mode = mode; // 'gap' | 'radial'
    this.value = value;
    this.labelOffset = null;
    this.labelParallel = null;
    this.labelAngle = null;
    this.labelDist = null;
    this.driven = false;
  }
  refs() { return [this.c1, this.c2]; }
  residuals(L) {
    if (this.driven) return [];
    if (this.mode === 'gap') {
      const dx = L(this.c2,'x') - L(this.c1,'x');
      const dy = L(this.c2,'y') - L(this.c1,'y');
      return [Math.hypot(dx, dy) - L(this.c1,'r') - L(this.c2,'r') - this.value];
    }
    return [L(this.c1,'r') - L(this.c2,'r') - this.value];
  }
  toJSON() {
    const o = { id:this.id, kind:'curveDistance', c1:this.c1, c2:this.c2, mode:this.mode, value:this.value };
    if (this.labelOffset != null) o.labelOffset = this.labelOffset;
    if (this.labelParallel != null) o.labelParallel = this.labelParallel;
    if (this.labelAngle != null) o.labelAngle = this.labelAngle;
    if (this.labelDist != null) o.labelDist = this.labelDist;
    if (this.driven) o.driven = true;
    return o;
  }
}

export class OffsetConstraint extends Constraint {
  /** Marks entity B as a geometric offset of entity A.
   *  For lines: enforces parallelism (replaces ParallelConstraint).
   *  For circles/arcs: enforces concentricity (replaces ConcentricConstraint).
   *  No value — the distance is handled separately by OffsetDistanceConstraint. */
  constructor(sourceEntityId, targetEntityId, offsetKind, pts) {
    super('offset');
    this.sourceEntityId = sourceEntityId;
    this.targetEntityId = targetEntityId;
    this.offsetKind = offsetKind; // 'line' | 'circle'
    // For lines: pts = { l1: {a,b}, l2: {a,b} }  (point IDs of source & target lines)
    // For circles/arcs: pts = { p1: centerId, p2: centerId }
    Object.assign(this, pts);
  }
  refs() {
    if (this.offsetKind === 'line')
      return [this.sourceEntityId, this.targetEntityId, this.l1.a, this.l1.b, this.l2.a, this.l2.b];
    return [this.sourceEntityId, this.targetEntityId, this.p1, this.p2];
  }
  residuals(L) {
    if (this.offsetKind === 'line') {
      const dx1=L(this.l1.b,'x')-L(this.l1.a,'x'), dy1=L(this.l1.b,'y')-L(this.l1.a,'y');
      const dx2=L(this.l2.b,'x')-L(this.l2.a,'x'), dy2=L(this.l2.b,'y')-L(this.l2.a,'y');
      const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
      if (len1 < EPS || len2 < EPS) return [0, 1];
      return [
        (dx1*dy2 - dy1*dx2) / (len1 * len2), // parallel
        (dx1*dx2 + dy1*dy2) / (len1 * len2) - 1 // same direction
      ];
    }
    return [L(this.p1,'x')-L(this.p2,'x'), L(this.p1,'y')-L(this.p2,'y')]; // concentric
  }
  toJSON() {
    const o = { id:this.id, kind:'offset', sourceEntityId:this.sourceEntityId,
      targetEntityId:this.targetEntityId, offsetKind:this.offsetKind };
    if (this.offsetKind === 'line') { o.l1 = this.l1; o.l2 = this.l2; }
    else { o.p1 = this.p1; o.p2 = this.p2; }
    return o;
  }
}

export class OffsetDistanceConstraint extends Constraint {
  /** Shared distance value for an entire offset operation.
   *  Stores one entry per offset pair and emits one residual per pair,
   *  so changing this single value updates all offset entities at once.
   *  pairs: Array of
   *    { kind:'line',   pointId, l:{a,b} }  — same math as PointLineDistanceConstraint
   *    { kind:'circle', c1:entityId, c2:entityId } — same math as CurveDistanceConstraint radial */
  constructor(pairs, value) {
    super('offsetDistance');
    this.pairs = pairs;
    this.value = value;
    this.labelOffset = null; this.labelParallel = null;
    this.labelAngle = null; this.labelDist = null; this.driven = false;
  }
  refs() {
    return this.pairs.flatMap(p =>
      p.kind === 'line' ? [p.pointId, p.l.a, p.l.b] : [p.c1, p.c2]
    );
  }
  residuals(L) {
    if (this.driven) return [];
    return this.pairs.map(p => {
      if (p.kind === 'line') {
        const px=L(p.pointId,'x'), py=L(p.pointId,'y');
        const ax=L(p.l.a,'x'), ay=L(p.l.a,'y'), bx=L(p.l.b,'x'), by=L(p.l.b,'y');
        const dx=bx-ax, dy=by-ay;
        const len = Math.hypot(dx, dy);
        if (len < EPS) return 0;
        const cross = dx*(py-ay) - dy*(px-ax);
        const value = p.value != null ? p.value : (cross < 0 ? -Math.abs(this.value) : Math.abs(this.value));
        return cross / len - value;
      }
      const radial = L(p.c1,'r') - L(p.c2,'r');
      const value = p.value != null ? p.value : (radial < 0 ? -Math.abs(this.value) : Math.abs(this.value));
      return radial - value; // radial
    });
  }
  toJSON() {
    const o = { id:this.id, kind:'offsetDistance', pairs:this.pairs, value:this.value };
    if (this.labelOffset   != null) o.labelOffset   = this.labelOffset;
    if (this.labelParallel != null) o.labelParallel = this.labelParallel;
    if (this.labelAngle    != null) o.labelAngle    = this.labelAngle;
    if (this.labelDist     != null) o.labelDist     = this.labelDist;
    if (this.driven) o.driven = true;
    return o;
  }
}

export class AngleConstraint extends Constraint {
  /** Angle between two lines, in radians (0 .. π), measured between their
   *  directions a → b: the sector the dimension was placed in (the
   *  smaller of the two sectors between those directions). 60° and 120°
   *  are different dimensions, and every value from 0 to 180° can be
   *  reached (a cosine-based residual can't tell an angle from its
   *  supplement and has no slope at 0° and 180°). */
  constructor(l1Pts, l2Pts, value) {
    super('angle'); this.l1=l1Pts; this.l2=l2Pts; this.value=normalizeAngleValue(value);
    this.labelDist=null; this.labelMidAngle=null; this.driven=false;
  }
  refs() { return [this.l1.a, this.l1.b, this.l2.a, this.l2.b]; }
  /** Current angle between the directions, in [0, π], or null. */
  static measure(L, l1, l2) {
    const phi = AngleConstraint.signed(L, l1, l2);
    return phi == null ? null : Math.abs(phi);
  }
  /** Signed angle from l1's direction to l2's, in (−π, π], or null. */
  static signed(L, l1, l2) {
    const dx1=L(l1.b,'x')-L(l1.a,'x'), dy1=L(l1.b,'y')-L(l1.a,'y');
    const dx2=L(l2.b,'x')-L(l2.a,'x'), dy2=L(l2.b,'y')-L(l2.a,'y');
    if (Math.hypot(dx1, dy1) < EPS || Math.hypot(dx2, dy2) < EPS) return null;
    return Math.atan2(dx1*dy2 - dy1*dx2, dx1*dx2 + dy1*dy2);
  }
  /** Before a solve: which side of l1 the angle opens to, from the
   *  geometry as it is (kept for the whole solve, so overshooting past
   *  the line can't flip the shape). Right on the line (0° or 180°) the
   *  side from before is kept. */
  prepare(L) {
    const phi = AngleConstraint.signed(L, this.l1, this.l2);
    if (phi != null && Math.abs(Math.sin(phi)) > 1e-3) this.side = phi < 0 ? -1 : 1;
  }
  residuals(L) {
    if (this.driven) return [];
    const phi = AngleConstraint.signed(L, this.l1, this.l2);
    if (phi == null) return [0];
    let d = (this.side || 1) * phi - this.value;
    while (d > Math.PI) d -= TAU;
    while (d <= -Math.PI) d += TAU;
    // In length units (the arc the error sweeps on the lines), like the
    // other constraints, so a turn of a long line isn't damped away.
    const dx1=L(this.l1.b,'x')-L(this.l1.a,'x'), dy1=L(this.l1.b,'y')-L(this.l1.a,'y');
    const dx2=L(this.l2.b,'x')-L(this.l2.a,'x'), dy2=L(this.l2.b,'y')-L(this.l2.a,'y');
    return [ d * Math.sqrt(Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2)) ];
  }
  toJSON() {
    const o = { id:this.id, kind:'angle', l1:this.l1, l2:this.l2, value:this.value };
    if (this.labelDist     != null) o.labelDist     = this.labelDist;
    if (this.labelMidAngle != null) o.labelMidAngle = this.labelMidAngle;
    if (this.driven) o.driven = true;
    return o;
  }
}

export class DirectedAngleConstraint extends Constraint {
  constructor(l1Pts, l2Pts, value) {
    super('directedAngle');
    this.l1 = l1Pts;
    this.l2 = l2Pts;
    this.value = value;
  }
  refs() { return [this.l1.a, this.l1.b, this.l2.a, this.l2.b]; }
  residuals(L) {
    const dx1=L(this.l1.b,'x')-L(this.l1.a,'x'), dy1=L(this.l1.b,'y')-L(this.l1.a,'y');
    const dx2=L(this.l2.b,'x')-L(this.l2.a,'x'), dy2=L(this.l2.b,'y')-L(this.l2.a,'y');
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
    if (len1 < EPS || len2 < EPS) return [0];
    const dot = (dx1*dx2 + dy1*dy2) / (len1 * len2);
    const cross = (dx1*dy2 - dy1*dx2) / (len1 * len2);
    let delta = Math.atan2(cross, dot) - this.value;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    return [ delta ];
  }
  toJSON() { return { id:this.id, kind:'directedAngle', l1:this.l1, l2:this.l2, value:this.value }; }
}

export class PointOnLineConstraint extends Constraint {
  constructor(pointId, l) { super('pointOnLine'); this.pointId=pointId; this.l=l; }
  refs() { return [this.pointId, this.l.a, this.l.b]; }
  residuals(L) {
    const px=L(this.pointId,'x'), py=L(this.pointId,'y');
    const ax=L(this.l.a,'x'), ay=L(this.l.a,'y');
    const bx=L(this.l.b,'x'), by=L(this.l.b,'y');
    return [ (bx-ax)*(py-ay) - (by-ay)*(px-ax) ];
  }
  toJSON() { return { id:this.id, kind:'pointOnLine', pointId:this.pointId, l:this.l }; }
}

export class PointOnCircleConstraint extends Constraint {
  constructor(pointId, circleId, centerId) {
    super('pointOnCircle');
    this.pointId=pointId; this.circleId=circleId; this.centerId=centerId;
  }
  refs() { return [this.pointId, this.circleId, this.centerId]; }
  residuals(L) {
    const dx=L(this.pointId,'x')-L(this.centerId,'x');
    const dy=L(this.pointId,'y')-L(this.centerId,'y');
    return [ Math.sqrt(dx*dx+dy*dy) - L(this.circleId,'r') ];
  }
  toJSON() { return { id:this.id, kind:'pointOnCircle', pointId:this.pointId, circleId:this.circleId, centerId:this.centerId }; }
}

export function arcEndpointXY(L, ref) {
  const angleKey = ref.which === 'start' ? 'a0' : 'a1';
  const a = L(ref.arcId, angleKey);
  const r = L(ref.arcId, 'r');
  return {
    x: L(ref.centerId, 'x') + r * Math.cos(a),
    y: L(ref.centerId, 'y') + r * Math.sin(a)
  };
}

export function pointRefXY(L, ref) {
  if (ref.pointId) return { x: L(ref.pointId, 'x'), y: L(ref.pointId, 'y') };
  return arcEndpointXY(L, ref);
}

export function pointRefIds(ref) {
  return ref.pointId ? [ref.pointId] : [ref.arcId, ref.centerId];
}

export class ArcEndpointCoincidentConstraint extends Constraint {
  constructor(ref, pointId) {
    super('arcEndpointCoincident');
    this.ref = ref;
    this.pointId = pointId;
  }
  refs() { return [this.ref.arcId, this.ref.centerId, this.pointId]; }
  residuals(L) {
    const p = arcEndpointXY(L, this.ref);
    return [p.x - L(this.pointId, 'x'), p.y - L(this.pointId, 'y')];
  }
  toJSON() { return { id:this.id, kind:'arcEndpointCoincident', ref:this.ref, pointId:this.pointId }; }
}

export class ArcEndpointArcEndpointCoincidentConstraint extends Constraint {
  /** angular: the two arcs share a centre and are already held to the same
   *  radius elsewhere (a circle split in two: the other joint does it), so
   *  only the angles have to meet. One equation instead of two, so the
   *  closed loop isn't over-constrained. */
  constructor(ref1, ref2, angular = false) {
    super('arcEndpointArcEndpointCoincident');
    this.ref1 = ref1;
    this.ref2 = ref2;
    this.angular = !!angular && ref1.centerId === ref2.centerId;
  }
  refs() { return [this.ref1.arcId, this.ref1.centerId, this.ref2.arcId, this.ref2.centerId]; }
  residuals(L) {
    if (this.angular) {
      const a1 = L(this.ref1.arcId, this.ref1.which === 'start' ? 'a0' : 'a1');
      const a2 = L(this.ref2.arcId, this.ref2.which === 'start' ? 'a0' : 'a1');
      let d = (a1 - a2 + Math.PI) % (2 * Math.PI);
      if (d < 0) d += 2 * Math.PI;
      return [(d - Math.PI) * L(this.ref1.arcId, 'r')];
    }
    const a = arcEndpointXY(L, this.ref1);
    const b = arcEndpointXY(L, this.ref2);
    return [a.x - b.x, a.y - b.y];
  }
  toJSON() {
    const o = { id:this.id, kind:'arcEndpointArcEndpointCoincident', ref1:this.ref1, ref2:this.ref2 };
    if (this.angular) o.angular = true;
    return o;
  }
}

export class PointRefHorizontalConstraint extends Constraint {
  constructor(ref1, ref2) {
    super('pointRefHorizontal');
    this.ref1 = ref1;
    this.ref2 = ref2;
  }
  refs() { return [...pointRefIds(this.ref1), ...pointRefIds(this.ref2)]; }
  residuals(L) {
    const a = pointRefXY(L, this.ref1);
    const b = pointRefXY(L, this.ref2);
    return [a.y - b.y];
  }
  toJSON() { return { id:this.id, kind:'pointRefHorizontal', ref1:this.ref1, ref2:this.ref2 }; }
}

export class PointRefVerticalConstraint extends Constraint {
  constructor(ref1, ref2) {
    super('pointRefVertical');
    this.ref1 = ref1;
    this.ref2 = ref2;
  }
  refs() { return [...pointRefIds(this.ref1), ...pointRefIds(this.ref2)]; }
  residuals(L) {
    const a = pointRefXY(L, this.ref1);
    const b = pointRefXY(L, this.ref2);
    return [a.x - b.x];
  }
  toJSON() { return { id:this.id, kind:'pointRefVertical', ref1:this.ref1, ref2:this.ref2 }; }
}

export class ArcEndpointMidpointConstraint extends Constraint {
  constructor(ref, l) {
    super('arcEndpointMidpoint');
    this.ref = ref;
    this.l = l;
  }
  refs() { return [this.ref.arcId, this.ref.centerId, this.l.a, this.l.b]; }
  residuals(L) {
    const p = arcEndpointXY(L, this.ref);
    return [
      2 * p.x - L(this.l.a, 'x') - L(this.l.b, 'x'),
      2 * p.y - L(this.l.a, 'y') - L(this.l.b, 'y')
    ];
  }
  toJSON() { return { id:this.id, kind:'arcEndpointMidpoint', ref:this.ref, l:this.l }; }
}

export class ArcEndpointFixConstraint extends Constraint {
  constructor(ref, x, y) {
    super('arcEndpointFix');
    this.ref = ref;
    this.x = x;
    this.y = y;
  }
  refs() { return [this.ref.arcId, this.ref.centerId]; }
  residuals(L) {
    const p = arcEndpointXY(L, this.ref);
    return [p.x - this.x, p.y - this.y];
  }
  toJSON() { return { id:this.id, kind:'arcEndpointFix', ref:this.ref, x:this.x, y:this.y }; }
}

export class ArcEndpointOnLineConstraint extends Constraint {
  constructor(ref, l) {
    super('arcEndpointOnLine');
    this.ref = ref;
    this.l = l;
  }
  refs() { return [this.ref.arcId, this.ref.centerId, this.l.a, this.l.b]; }
  residuals(L) {
    const p = arcEndpointXY(L, this.ref);
    const ax=L(this.l.a,'x'), ay=L(this.l.a,'y');
    const bx=L(this.l.b,'x'), by=L(this.l.b,'y');
    return [ (bx-ax)*(p.y-ay) - (by-ay)*(p.x-ax) ];
  }
  toJSON() { return { id:this.id, kind:'arcEndpointOnLine', ref:this.ref, l:this.l }; }
}

export class ArcEndpointOnCircleConstraint extends Constraint {
  constructor(ref, circleId, centerId) {
    super('arcEndpointOnCircle');
    this.ref = ref;
    this.circleId = circleId;
    this.centerId = centerId;
  }
  refs() { return [this.ref.arcId, this.ref.centerId, this.circleId, this.centerId]; }
  residuals(L) {
    const p = arcEndpointXY(L, this.ref);
    const dx=p.x-L(this.centerId,'x'), dy=p.y-L(this.centerId,'y');
    return [ Math.sqrt(dx*dx+dy*dy) - L(this.circleId,'r') ];
  }
  toJSON() { return { id:this.id, kind:'arcEndpointOnCircle', ref:this.ref, circleId:this.circleId, centerId:this.centerId }; }
}

/** Display name of a constraint (horizontal / vertical distances by axis). */
export function constraintLabel(c) {
  if (c && c.kind === 'distance' && c.axis) return c.axis === 'x' ? 'Horizontal distance' : 'Vertical distance';
  if (c && c.kind === 'pattern') return { linear: 'Linear pattern', circular: 'Circular pattern', points: 'Point pattern' }[c.type] || 'Pattern';
  return CONSTRAINT_LABELS[c?.kind] || c?.kind;
}

/* ---- Bézier curves (see core/bezier.js) ----
   A curve's end direction is its handle: anchor → handle. */

/** The curve leaves its anchor along a line, or tangent to a circle /
 *  arc through the anchor. target: { line: {a, b} } | { circle: id, centerId }. */
export class CurveTangentConstraint extends Constraint {
  constructor(anchorId, handleId, target) {
    super('curveTangent');
    this.anchorId = anchorId; this.handleId = handleId;
    this.line = target.line ? { a: target.line.a, b: target.line.b } : null;
    this.circleId = target.circle || null; this.centerId = target.centerId || null;
  }
  refs() { return this.line ? [this.anchorId, this.handleId, this.line.a, this.line.b] : [this.anchorId, this.handleId, this.circleId, this.centerId]; }
  residuals(L) {
    const ax = L(this.anchorId, 'x'), ay = L(this.anchorId, 'y');
    const hx = L(this.handleId, 'x') - ax, hy = L(this.handleId, 'y') - ay;
    if (this.line) {
      const ux = L(this.line.b, 'x') - L(this.line.a, 'x'), uy = L(this.line.b, 'y') - L(this.line.a, 'y');
      const n = Math.hypot(ux, uy);
      return [n < EPS ? 0 : (hx * uy - hy * ux) / n];
    }
    const rx = ax - L(this.centerId, 'x'), ry = ay - L(this.centerId, 'y');
    const n = Math.hypot(rx, ry);
    return [n < EPS ? 0 : (hx * rx + hy * ry) / n];
  }
  toJSON() {
    return { id: this.id, kind: 'curveTangent', anchorId: this.anchorId, handleId: this.handleId,
      ...(this.line ? { line: this.line } : { circleId: this.circleId, centerId: this.centerId }) };
  }
  static fromJSON(o) {
    return new CurveTangentConstraint(o.anchorId, o.handleId, o.line ? { line: o.line } : { circle: o.circleId, centerId: o.centerId });
  }
}

/** Two curves meet without a kink: both handles at their shared anchor
 *  are on one line through it (G1; handle lengths stay free). */
export class SmoothConstraint extends Constraint {
  constructor(anchorId, h1Id, h2Id) { super('smooth'); this.anchorId = anchorId; this.h1 = h1Id; this.h2 = h2Id; }
  refs() { return [this.anchorId, this.h1, this.h2]; }
  residuals(L) {
    const ax = L(this.anchorId, 'x'), ay = L(this.anchorId, 'y');
    const ux = L(this.h1, 'x') - ax, uy = L(this.h1, 'y') - ay;
    const vx = ax - L(this.h2, 'x'), vy = ay - L(this.h2, 'y');
    const n = Math.hypot(vx, vy);
    return [n < EPS ? 0 : (ux * vy - uy * vx) / n];
  }
  toJSON() { return { id: this.id, kind: 'smooth', anchorId: this.anchorId, h1: this.h1, h2: this.h2 }; }
}

/** A point lies on a Bézier curve (anywhere along it). pts: [p1, c1, c2, p2] ids. */
export class PointOnCurveConstraint extends Constraint {
  constructor(pointId, curveId, pts) { super('pointOnCurve'); this.pointId = pointId; this.curveId = curveId; this.pts = [...pts]; }
  refs() { return [this.pointId, this.curveId, ...this.pts]; }
  residuals(L) {
    const P = this.pts.map(id => ({ x: L(id, 'x'), y: L(id, 'y') }));
    const q = { x: L(this.pointId, 'x'), y: L(this.pointId, 'y') };
    const near = bezierNearest(P, q, 16);
    const b = bezierAt(P, near.t), u = bezierTangent(P, near.t);
    return [(q.x - b.x) * -u.y + (q.y - b.y) * u.x];
  }
  toJSON() { return { id: this.id, kind: 'pointOnCurve', pointId: this.pointId, curveId: this.curveId, pts: this.pts }; }
}

export const CONSTRAINT_LABELS = {
  fix:'Fix', coincident:'Coincident', horizontal:'Horizontal',
  vertical:'Vertical', parallel:'Parallel', perpendicular:'Perpendicular',
  collinear:'Collinear', equalLength:'Equal length', equalRadius:'Equal radius',
  concentric:'Concentric', tangent:'Tangent', midpoint:'Midpoint', symmetric:'Symmetric',
  arcEndpointCoincident:'Arc endpoint coincident', arcEndpointArcEndpointCoincident:'Arc endpoint coincident',
  pointRefHorizontal:'Horizontal', pointRefVertical:'Vertical',
  arcEndpointFix:'Arc endpoint fixed', arcEndpointMidpoint:'Arc endpoint midpoint',
  arcEndpointOnLine:'Arc endpoint on line', arcEndpointOnCircle:'Arc endpoint on circle',
  distance:'Distance', radius:'Radius', curveDistance:'Curve distance', angle:'Angle', directedAngle:'Central angle',
  pointLineDistance:'Pt-Line dist',
  pointOnLine:'On line', pointOnCircle:'On circle',
  offset:'Offset', offsetDistance:'Offset dist', pattern:'Pattern',
  curveTangent:'Tangent', smooth:'Smooth', pointOnCurve:'On curve'
};

export const CONSTRAINT_GLYPHS = {
  fix:'⚓', coincident:'⌖', horizontal:'━', vertical:'┃',
  parallel:'∥', perpendicular:'⟂', collinear:'≡',
  equal:'＝', equalLength:'＝', equalRadius:'＝',
  concentric:'⊙', tangent:'∽', midpoint:'⌐', symmetric:'⇋',
  arcEndpointCoincident:'⌖', arcEndpointArcEndpointCoincident:'⌖',
  pointRefHorizontal:'━', pointRefVertical:'┃',
  arcEndpointFix:'⚓', arcEndpointMidpoint:'⌐',
  arcEndpointOnLine:'⊥•', arcEndpointOnCircle:'○•',
  distance:'↔', radius:'R', diameter:'⌀', curveDistance:'↔', angle:'∠',
  pointLineDistance:'↔',
  pointOnLine:'⊥•', pointOnCircle:'○•',
  offset:'⊿', offsetDistance:'↔', pattern:'▦',
  curveTangent:'∽', smooth:'S', pointOnCurve:'∿•'
};

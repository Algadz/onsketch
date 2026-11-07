import { EPS, TAU, normalizeAngleValue } from './math.js';
import { newId } from './entities.js';

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
  /** Distance from center to line equals radius (squared form, sign-free). */
  constructor(l, circleId, centerId) { super('tangent'); this.l=l; this.circleId=circleId; this.centerId=centerId; }
  refs() { return [this.l.a, this.l.b, this.circleId, this.centerId]; }
  residuals(L) {
    const ax=L(this.l.a,'x'), ay=L(this.l.a,'y');
    const bx=L(this.l.b,'x'), by=L(this.l.b,'y');
    const cx=L(this.centerId,'x'), cy=L(this.centerId,'y');
    const r=L(this.circleId,'r');
    const dx=bx-ax, dy=by-ay;
    const cross = dx*(cy-ay) - dy*(cx-ax);
    const len2 = dx*dx + dy*dy;
    return [ cross*cross - r*r*len2 ];
  }
  toJSON() { return { id:this.id, kind:'tangent', l:this.l, circleId:this.circleId, centerId:this.centerId }; }
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

export class DistanceConstraint extends Constraint {
  constructor(p1Id, p2Id, value) {
    super('distance'); this.p1=p1Id; this.p2=p2Id; this.value=value;
    this.labelOffset=null; this.labelParallel=null; this.driven=false;
  }
  refs() { return [this.p1, this.p2]; }
  residuals(L) {
    if (this.driven) return [];
    const dx=L(this.p1,'x')-L(this.p2,'x'), dy=L(this.p1,'y')-L(this.p2,'y');
    return [ Math.sqrt(dx*dx+dy*dy) - this.value ];
  }
  toJSON() {
    const o = { id:this.id, kind:'distance', p1:this.p1, p2:this.p2, value:this.value };
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
    const len2 = dx*dx + dy*dy;
    return [ cross*cross - this.value*this.value*len2 ];
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
  /** Angle between two line entities, in radians (0 .. π). The solver
   *  constrains the undirected line pair so dragging an endpoint through
   *  the opposite endpoint does not mirror the line to preserve a directed
   *  segment vector. The stored value still selects the displayed sector. */
  constructor(l1Pts, l2Pts, value) {
    super('angle'); this.l1=l1Pts; this.l2=l2Pts; this.value=normalizeAngleValue(value);
    this.labelDist=null; this.labelMidAngle=null; this.driven=false;
  }
  refs() { return [this.l1.a, this.l1.b, this.l2.a, this.l2.b]; }
  residuals(L) {
    if (this.driven) return [];
    const dx1=L(this.l1.b,'x')-L(this.l1.a,'x'), dy1=L(this.l1.b,'y')-L(this.l1.a,'y');
    const dx2=L(this.l2.b,'x')-L(this.l2.a,'x'), dy2=L(this.l2.b,'y')-L(this.l2.a,'y');
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
    if (len1 < EPS || len2 < EPS) return [0];
    const cosAng = (dx1*dx2 + dy1*dy2) / (len1 * len2);
    const target = Math.cos(this.value);
    if (Math.abs(target) < 1e-9) return [ cosAng ];
    return [ Math.sign(cosAng || target) === Math.sign(target)
      ? cosAng - target
      : -cosAng - target ];
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
  constructor(ref1, ref2) {
    super('arcEndpointArcEndpointCoincident');
    this.ref1 = ref1;
    this.ref2 = ref2;
  }
  refs() { return [this.ref1.arcId, this.ref1.centerId, this.ref2.arcId, this.ref2.centerId]; }
  residuals(L) {
    const a = arcEndpointXY(L, this.ref1);
    const b = arcEndpointXY(L, this.ref2);
    return [a.x - b.x, a.y - b.y];
  }
  toJSON() { return { id:this.id, kind:'arcEndpointArcEndpointCoincident', ref1:this.ref1, ref2:this.ref2 }; }
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
  offset:'Offset', offsetDistance:'Offset dist'
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
  offset:'⊿', offsetDistance:'↔'
};

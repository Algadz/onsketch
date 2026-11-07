import { Arc, Circle, Line, Point, ensureIdAbove, newId } from './entities.js';
import { AngleConstraint, ArcEndpointArcEndpointCoincidentConstraint, ArcEndpointCoincidentConstraint, ArcEndpointFixConstraint, ArcEndpointMidpointConstraint, ArcEndpointOnCircleConstraint, ArcEndpointOnLineConstraint, CoincidentConstraint, CollinearConstraint, ConcentricConstraint, CurveDistanceConstraint, DirectedAngleConstraint, DistanceConstraint, EqualLengthConstraint, EqualRadiusConstraint, FixConstraint, HorizontalConstraint, MidpointConstraint, OffsetConstraint, OffsetDistanceConstraint, ParallelConstraint, PerpendicularConstraint, PointLineDistanceConstraint, PointOnCircleConstraint, PointOnLineConstraint, PointRefHorizontalConstraint, PointRefVerticalConstraint, RadiusConstraint, SymmetricConstraint, TangentCircleCircleConstraint, TangentLineCircleConstraint, VerticalConstraint } from './constraints.js';

/* =============== 5. SKETCH / PROJECT MODEL ==================== */
export class Sketch {
  constructor(name='Sketch 1') {
    this.id = newId('s');
    this.name = name;
    this.visible = true;
    this.entities = [];
    this.constraints = [];
    this.features = [];
    this.dirtyIds = new Set();
  }
  addEntity(e) {
    e.layerId = this.id;
    this.entities.push(e);
    const mark = (x) => {
      this.dirtyIds.add(x.id);
      for (const c of x.children()) mark(c);
    };
    mark(e);
  }
  removeEntity(e) {
    this.entities = this.entities.filter(x => x !== e);
    const ids = new Set();
    const walk = (x) => { ids.add(x.id); for (const c of x.children()) walk(c); };
    walk(e);
    const liveIds = new Set();
    for (const en of this.entities) walkLive(en);
    function walkLive(x) {
      liveIds.add(x.id);
      for (const c of x.children()) walkLive(c);
    }
    const staleIds = new Set([...ids].filter(id => !liveIds.has(id)));
    this.constraints = this.constraints.filter(c => !c.refs().some(r => staleIds.has(r)));
    this.features = (this.features || []).filter(f => {
      const refs = []
        .concat(f.sourceEntityIds || [])
        .concat(f.generatedEntityIds || []);
      return !refs.some(id => staleIds.has(id));
    });
  }
  toJSON() {
    const o = {
      id:this.id, name:this.name, visible:this.visible,
      entities:this.entities.map(e => e.toJSON()),
      constraints:this.constraints.map(c => c.toJSON())
    };
    if (this.features && this.features.length) o.features = this.features;
    return o;
  }
}

export class Project {
  constructor() {
    this.name = 'Untitled';
    this.units = 'mm';
    this.sketches = [];
    this.activeSketchId = null;
  }
  addSketch(name) {
    const s = new Sketch(name || ('Sketch ' + (this.sketches.length + 1)));
    this.sketches.push(s);
    if (!this.activeSketchId) this.activeSketchId = s.id;
    return s;
  }
  removeSketch(id) {
    this.sketches = this.sketches.filter(s => s.id !== id);
    if (this.activeSketchId === id) this.activeSketchId = this.sketches[0]?.id || null;
  }
  active() { return this.sketches.find(s => s.id === this.activeSketchId); }
  visibleSketches() { return this.sketches.filter(s => s.visible); }
  sketchOf(entityOrPoint) {
    for (const s of this.sketches) {
      for (const c of s.constraints) if (c === entityOrPoint) return s;
      for (const e of s.entities) {
        if (e === entityOrPoint) return s;
        for (const c of e.children()) if (c === entityOrPoint) return s;
      }
    }
    return null;
  }
  toJSON() {
    return {
      version: 2, name:this.name, units:this.units,
      activeSketchId:this.activeSketchId,
      sketches:this.sketches.map(s => s.toJSON())
    };
  }
  static fromJSON(o) {
    const p = new Project();
    p.name  = o.name || 'Untitled';
    p.units = o.units || 'mm';
    p.sketches = (o.sketches || []).map(sj => {
      const s = new Sketch(sj.name);
      s.id = sj.id; s.visible = sj.visible !== false;
      s.features = Array.isArray(sj.features) ? sj.features.map(f => ({ ...f })) : [];
      // CRITICAL — shared point identity must be preserved across revival.
      // Without this map, a corner that was a single Point shared by two
      // lines comes back as TWO Points carrying the same id. The solver's
      // id→entity lookup then sees the duplicate and resolves to whichever
      // copy was walked last, leaving the other copy uncoupled — which
      // looks like "undo broke all the constraints".
      const idMap = new Map();
      const reviveEntity = (ej) => {
        if (ej.id && idMap.has(ej.id)) return idMap.get(ej.id);
        let e;
        if (ej.type === 'point')        e = new Point(ej.x, ej.y);
        else if (ej.type === 'line')   { const a = reviveEntity(ej.p1), b = reviveEntity(ej.p2); e = new Line(a, b); }
        else if (ej.type === 'circle') { const c = reviveEntity(ej.center); e = new Circle(c, ej.r); }
        else if (ej.type === 'arc')    { const c = reviveEntity(ej.center); e = new Arc(c, ej.r, ej.a0, ej.a1); }
        else return null;
        if (ej.id) e.id = ej.id;
        e.construction = !!ej.construction;
        e.fixed = !!ej.fixed;
        if (e instanceof Arc) e.clockwise = !!ej.clockwise;
        if (ej.id) idMap.set(ej.id, e);
        return e;
      };
      for (const ej of sj.entities) {
        const e = reviveEntity(ej);
        if (e) s.addEntity(e);
      }
      s.dirtyIds.clear();
      for (const cj of (sj.constraints || [])) {
        let c = null;
        switch (cj.kind) {
          case 'fix':           c = new FixConstraint(cj.pointId, cj.x, cj.y); break;
          case 'coincident':    c = new CoincidentConstraint(cj.p1, cj.p2); break;
          case 'horizontal':    c = new HorizontalConstraint(cj.lineId, cj.p1, cj.p2); break;
          case 'vertical':      c = new VerticalConstraint(cj.lineId, cj.p1, cj.p2); break;
          case 'pointRefHorizontal': c = new PointRefHorizontalConstraint(cj.ref1, cj.ref2); break;
          case 'pointRefVertical': c = new PointRefVerticalConstraint(cj.ref1, cj.ref2); break;
          case 'symmetric':     c = new SymmetricConstraint(cj.p1, cj.p2, cj.axis, cj.sourceSide || null); break;
          case 'parallel':      c = new ParallelConstraint(cj.l1, cj.l2); break;
          case 'perpendicular': c = new PerpendicularConstraint(cj.l1, cj.l2); break;
          case 'collinear':     c = new CollinearConstraint(cj.l1, cj.l2); break;
          case 'equalLength':   c = new EqualLengthConstraint(cj.l1, cj.l2); break;
          case 'equalRadius':   c = new EqualRadiusConstraint(cj.c1, cj.c2); break;
          case 'concentric':    c = new ConcentricConstraint(cj.p1, cj.p2); break;
          case 'tangent':       c = new TangentLineCircleConstraint(cj.l, cj.circleId, cj.centerId); break;
          case 'tangentCC':     c = new TangentCircleCircleConstraint(cj.c1, cj.p1, cj.c2, cj.p2, !!cj.internal); break;
          case 'midpoint':      c = new MidpointConstraint(cj.pointId, cj.l); break;
          case 'distance':      c = new DistanceConstraint(cj.p1, cj.p2, cj.value); break;
          case 'pointLineDistance': c = new PointLineDistanceConstraint(cj.pointId, cj.l, cj.value); break;
          case 'radius':        c = new RadiusConstraint(cj.circleId, cj.value); break;
          case 'curveDistance': c = new CurveDistanceConstraint(cj.c1, cj.c2, cj.mode, cj.value); break;
          case 'angle':         c = new AngleConstraint(cj.l1, cj.l2, cj.value); break;
          case 'directedAngle': c = new DirectedAngleConstraint(cj.l1, cj.l2, cj.value); break;
          case 'pointOnLine':   c = new PointOnLineConstraint(cj.pointId, cj.l); break;
          case 'pointOnCircle': c = new PointOnCircleConstraint(cj.pointId, cj.circleId, cj.centerId); break;
          case 'arcEndpointCoincident': c = new ArcEndpointCoincidentConstraint(cj.ref, cj.pointId); break;
          case 'arcEndpointArcEndpointCoincident': c = new ArcEndpointArcEndpointCoincidentConstraint(cj.ref1, cj.ref2); break;
          case 'arcEndpointMidpoint': c = new ArcEndpointMidpointConstraint(cj.ref, cj.l); break;
          case 'arcEndpointFix': c = new ArcEndpointFixConstraint(cj.ref, cj.x, cj.y); break;
          case 'arcEndpointOnLine': c = new ArcEndpointOnLineConstraint(cj.ref, cj.l); break;
          case 'arcEndpointOnCircle': c = new ArcEndpointOnCircleConstraint(cj.ref, cj.circleId, cj.centerId); break;
          case 'offset': c = new OffsetConstraint(cj.sourceEntityId, cj.targetEntityId, cj.offsetKind,
            cj.offsetKind === 'line' ? { l1: cj.l1, l2: cj.l2 } : { p1: cj.p1, p2: cj.p2 }); break;
          case 'offsetDistance': c = new OffsetDistanceConstraint(cj.pairs, cj.value); break;
        }
        if (c) {
          if (cj.id) c.id = cj.id;
          if (cj.labelOffset   != null) c.labelOffset   = cj.labelOffset;
          if (cj.labelParallel != null) c.labelParallel = cj.labelParallel;
          if (cj.labelAngle    != null) c.labelAngle    = cj.labelAngle;
          if (cj.labelDist     != null) c.labelDist     = cj.labelDist;
          if (cj.labelMidAngle != null) c.labelMidAngle = cj.labelMidAngle;
          if (cj.isDiameter)            c.isDiameter    = true;
          if (cj.driven)                c.driven        = true;
          s.constraints.push(c);
        }
      }
      return s;
    });
    p.activeSketchId = o.activeSketchId || (p.sketches[0]?.id ?? null);
    // Bump the global id counter past any id we just read so newly created
    // entities/constraints can't collide with existing ones.
    let maxN = 0;
    const noteId = (id) => {
      if (typeof id !== 'string') return;
      const m = id.match(/^[a-z]+(\d+)$/i);
      if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
    };
    for (const s of p.sketches) {
      noteId(s.id);
      const walk = (e) => { noteId(e.id); for (const c of e.children()) walk(c); };
      for (const e of s.entities) walk(e);
      for (const c of s.constraints) noteId(c.id);
    }
    ensureIdAbove(maxN);
    return p;
  }
}

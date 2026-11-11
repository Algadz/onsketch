import { Arc, Circle, Line, Point, ensureIdAbove, newId } from './entities.js';
import { Layer, cleanStyle, legacyFill } from './style.js';
import { findClosedProfiles, interiorPoint, planarCycles } from './regions.js';

/** Older files filled shapes through their style. Each closed region
 *  formed by same-colour shapes on a layer becomes one Fill-tool fill. */
function convertLegacyFills(items, sketch) {
  const groups = new Map();
  for (const it of items) {
    if (it.e.construction || !sketch.entities.includes(it.e)) continue;
    const key = it.e.layerId + '|' + it.color + '|' + it.opacity;
    if (!groups.has(key)) groups.set(key, { layerId: it.e.layerId, color: it.color, opacity: it.opacity, ents: [] });
    groups.get(key).ents.push(it.e);
  }
  const out = [];
  for (const g of groups.values()) {
    for (const c of planarCycles(g.ents)) {
      if (c.area <= 1e-9) continue;
      const seed = interiorPoint({ outer: c.pts, holes: [] });
      if (seed) out.push({ id: newId('f'), layerId: g.layerId, color: g.color, opacity: g.opacity, seed });
    }
  }
  return out;
}
import { ensureDimensionNames } from './equations.js';
import { reviveStroke, strokeToJSON } from './strokes.js';
import { imageSource, registerImage, usedImageIds } from './images.js';

/** Constraints that tie a point to itself or to a line it is an end of:
 *  always true, never useful, dropped on load. */
function isSelfReferential(c) {
  const ends = (l) => l && [l.a, l.b];
  if (c.kind === 'coincident') return c.p1 === c.p2;
  if (c.kind === 'pointOnLine' || c.kind === 'midpoint') return ends(c.l)?.includes(c.pointId);
  if (c.kind === 'pointOnCircle') return c.pointId === c.centerId;
  return false;
}

/** Fill from a file. Fills saved before seeds existed stored their
 *  outline as {outer:[ids], holes:[[ids]]}; an inside point is worked
 *  out from that outline. */
function reviveFill(f, sketch) {
  if (!f || typeof f !== 'object' || f.dormant) return null;     // hidden paint (older files) is dropped
  if (f.seed && Number.isFinite(f.seed.x)) return fillToJSON(f);
  if (!Array.isArray(f.outer)) return null;
  const byId = new Map(sketch.entities.map(e => [e.id, e]));
  const loop = (ids) => {
    const { loops, circles } = findClosedProfiles(ids.map(id => byId.get(id)).filter(Boolean));
    if (loops.length) return loops[0];
    const c = circles[0];
    if (!c) return null;
    return Array.from({ length: 64 }, (_, i) => ({ x: c.center.x + c.r * Math.cos(i / 32 * Math.PI), y: c.center.y + c.r * Math.sin(i / 32 * Math.PI) }));
  };
  const outer = loop(f.outer);
  if (!outer) return null;
  const holes = (f.holes || []).map(loop).filter(Boolean);
  const seed = interiorPoint({ outer, holes });
  if (!seed) return null;
  return fillToJSON({ ...f, seed });
}

/** Saved form of a fill (drops the transient region). */
export function fillToJSON(f) {
  const o = { id: f.id, layerId: f.layerId, color: f.color, opacity: f.opacity ?? 1, seed: { x: f.seed.x, y: f.seed.y } };
  return o;
}
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
    // Fill-tool fills: { id, layerId, color, opacity, seed:{x,y} } where the
    // seed is a point inside the painted area; the area is whatever closed
    // region the layer's shapes form around it. When shapes change, colours
    // are carried over to the areas (core/regions.js reconcileRegions);
    // paint whose area no longer exists is removed (undo brings it back).
    // A transient `region` (current outline) is attached at run time.
    this.fills = [];
    // Freehand ink from the Sketch window (core/strokes.js): free of the
    // solver, drawn on top of its layer's shapes.
    this.strokes = [];
    this.dirtyIds = new Set();
    this.project = null;          // back-reference, set by Project; not serialised
  }
  addEntity(e) {
    e.sketchId = this.id;
    if (this.project) {
      this.project.assignLayer(e);
      if (!e.style && this.project.drawStyle) e.style = { ...this.project.drawStyle };
    }
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
      constraints:this.constraints.map(c => {
        const o = c.toJSON();
        if (c.layerId) o.layerId = c.layerId; // layer the constraint / dimension belongs to
        if (c.name) o.name = c.name;          // dimension name for equations (D1…)
        if (c.expr) o.expr = c.expr;          // equation driving this dimension
        return o;
      })
    };
    if (this.features && this.features.length) o.features = this.features;
    if (this.fills.length) o.fills = this.fills.map(fillToJSON);
    if (this.strokes.length) o.strokes = this.strokes.map(strokeToJSON);
    return o;
  }
}

/* What the editor shows, saved with the project so it opens the way it
   was left: { grid, snap, dimensions, relations, dimNames }. Files from
   before this was saved have none (null): the editor then keeps its
   current setup and writes it into the project. */
export const DISPLAY_DEFAULTS = { grid: true, snap: true, dimensions: true, relations: true, dimNames: false };

export function cleanDisplay(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(DISPLAY_DEFAULTS)) out[k] = typeof d[k] === 'boolean' ? d[k] : v;
  return out;
}

export class Project {
  constructor() {
    this.name = 'Untitled';
    this.background = null;       // canvas fill colour set by the fill tool, or null
    this.display = null;          // grid / snap / dimensions / relations shown (cleanDisplay), or null when never set
    this.variables = [];          // global variables: { name, expr } (value/error are computed)
    this.drawStyle = null;        // style given to new entities (set by the editor; not saved)
    this.units = 'mm';
    this.sketches = [];
    this.activeSketchId = null;
    this.layers = [new Layer('Layer 1')];   // bottom → top
    this.activeLayerId = this.layers[0].id;
  }
  addSketch(name) {
    const s = new Sketch(name || ('Sketch ' + (this.sketches.length + 1)));
    s.project = this;
    this.sketches.push(s);
    if (!this.activeSketchId) this.activeSketchId = s.id;
    return s;
  }
  removeSketch(id) {
    this.sketches = this.sketches.filter(s => s.id !== id);
    if (this.activeSketchId === id) this.activeSketchId = this.sketches[0]?.id || null;
  }
  active() { return this.sketches.find(s => s.id === this.activeSketchId); }

  /* ---- Layers ---- */
  activeLayer() { return this.layer(this.activeLayerId) || this.layers[this.layers.length - 1]; }
  layer(id) { return this.layers.find(l => l.id === id) || null; }
  /** Layer that governs an entity's display. Child points (line ends,
   *  centres) follow their owner, which callers pass as `owner`. */
  layerOf(entity, owner = null) {
    const e = (owner && !entity.layerId) ? owner : entity;
    return this.layer(e.layerId) || this.layers[0];
  }
  assignLayer(e) {
    if (!e.layerId || !this.layer(e.layerId)) e.layerId = this.activeLayerId;
  }
  addLayer(name) {
    const l = new Layer(name || ('Layer ' + (this.layers.length + 1)));
    const i = this.layers.indexOf(this.activeLayer());
    this.layers.splice(i + 1, 0, l);       // just above the active layer
    this.activeLayerId = l.id;
    return l;
  }
  /** Removes a layer and every entity on it. The last layer can't go. */
  removeLayer(id) {
    if (this.layers.length <= 1) return false;
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return false;
    for (const s of this.sketches) s.fills = s.fills.filter(f => f.layerId !== id);
    for (const s of this.sketches) s.strokes = s.strokes.filter(st => st.layerId !== id);
    // Its shapes go, with the relations and dimensions on them (a point
    // shared with a shape on another layer stays, with its relations).
    for (const s of this.sketches) {
      for (const e of s.entities.filter(e => e.layerId === id)) s.removeEntity(e);
    }
    const other = this.layers.find(l => l.id !== id);
    for (const s of this.sketches) for (const c of s.constraints) if (c.layerId === id) c.layerId = other.id;
    this.layers.splice(i, 1);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.max(0, i - 1)].id;
    return true;
  }
  /** delta > 0 moves the layer up (drawn later, on top). */
  moveLayer(id, delta) {
    const i = this.layers.findIndex(l => l.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.layers.length) return false;
    const [l] = this.layers.splice(i, 1);
    this.layers.splice(j, 0, l);
    return true;
  }
  /** Layers are for display only: relations, dimensions and the solver
   *  ignore them, so nothing is ever held still because of its layer.
   *  Clears the transient `locked` flag the solver honours (kept for
   *  callers that sync before solving). */
  syncLocks() {
    const mark = (e) => { e.locked = false; for (const c of e.children()) mark(c); };
    for (const s of this.sketches) for (const e of s.entities) mark(e);
  }

  /** Layers of the shapes a constraint ties. */
  constraintLayerIds(c) {
    const ids = new Set(c.refs().filter(Boolean));
    const out = new Set();
    for (const s of this.sketches) for (const e of s.entities) {
      if (ids.has(e.id) || e.children().some(ch => ids.has(ch.id))) out.add(this.layerOf(e).id);
    }
    return out;
  }
  entitiesOnLayer(id) {
    const out = [];
    for (const s of this.sketches) for (const e of s.entities) if (e.layerId === id) out.push(e);
    return out;
  }
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
  /** Saved form. `images: false` leaves out the pictures' data (undo
   *  snapshots: the data stays in the session's registry). */
  toJSON({ images = true } = {}) {
    this.assignConstraintLayers();      // every constraint saved with its layer
    const pics = {};
    if (images) for (const id of usedImageIds(this)) { const src = imageSource(id); if (src) pics[id] = src; }
    return {
      version: 3, name:this.name, units:this.units,
      ...(this.background ? { background: this.background } : {}),
      ...(this.display ? { display: { ...this.display } } : {}),
      ...(this.variables.length ? { variables: this.variables.map(v => ({ name: v.name, expr: v.expr })) } : {}),
      activeSketchId:this.activeSketchId,
      activeLayerId:this.activeLayerId,
      layers:this.layers.map(l => l.toJSON()),
      sketches:this.sketches.map(s => s.toJSON()),
      ...(Object.keys(pics).length ? { images: pics } : {}),
    };
  }
  static fromJSON(o) {
    const p = new Project();
    if (o.images && typeof o.images === 'object') for (const [id, src] of Object.entries(o.images)) registerImage(src, id);
    p.name  = o.name || 'Untitled';
    p.units = o.units || 'mm';
    p.background = /^#[0-9a-f]{6}$/i.test(o.background || '') ? o.background : null;
    p.display = cleanDisplay(o.display);
    p.variables = Array.isArray(o.variables)
      ? o.variables.filter(v => v && typeof v.name === 'string' && typeof v.expr === 'string').map(v => ({ name: v.name, expr: v.expr }))
      : [];
    // Layers arrived in v3. Older files get the single default layer and
    // every entity lands on it (assignLayer below).
    const layerLook = new Map();
    if (Array.isArray(o.layers)) {
      for (const lj of o.layers) {
        const look = { lineWidth: lj.lineWidth, lineStyle: lj.lineStyle, fill: lj.fill, fillOpacity: lj.fillOpacity };
        if (cleanStyle(look) || legacyFill(look)) layerLook.set(lj.id, look);
      }
    }
    if (Array.isArray(o.layers) && o.layers.length) {
      p.layers = o.layers.map(Layer.fromJSON);
      p.activeLayerId = p.layer(o.activeLayerId) ? o.activeLayerId : p.layers[p.layers.length - 1].id;
    }
    p.sketches = (o.sketches || []).map(sj => {
      const s = new Sketch(sj.name);
      s.project = p;
      s.id = sj.id; s.visible = sj.visible !== false;
      s.features = Array.isArray(sj.features) ? sj.features.map(f => ({ ...f })) : [];
      s.fills = Array.isArray(sj.fills) ? sj.fills : [];
      s.strokes = Array.isArray(sj.strokes) ? sj.strokes.map(reviveStroke).filter(Boolean) : [];
      // CRITICAL — shared point identity must be preserved across revival.
      // Without this map, a corner that was a single Point shared by two
      // lines comes back as TWO Points carrying the same id. The solver's
      // id→entity lookup then sees the duplicate and resolves to whichever
      // copy was walked last, leaving the other copy uncoupled — which
      // looks like "undo broke all the constraints".
      const idMap = new Map();
      const legacyFills = [];
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
        if (ej.layerId) e.layerId = ej.layerId;
        // Files from when layers had styles: the layer's look moves onto
        // its entities so nothing changes on screen.
        const look = ej.style || (ej.layerId ? layerLook.get(ej.layerId) : null) || null;
        e.style = cleanStyle(look);
        const lf = legacyFill(look);
        if (lf) legacyFills.push({ e, ...lf });
        if (e instanceof Arc) e.clockwise = !!ej.clockwise;
        if (ej.id) idMap.set(ej.id, e);
        return e;
      };
      for (const ej of sj.entities) {
        const e = reviveEntity(ej);
        if (e) s.addEntity(e);
      }
      s.dirtyIds.clear();
      s.fills = s.fills.map(f => reviveFill(f, s)).filter(Boolean);
      s._legacyFills = legacyFills;     // converted once ids are bumped (below)
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
          case 'distance':      c = new DistanceConstraint(cj.p1, cj.p2, cj.value, cj.axis); break;
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
        if (c && isSelfReferential(c)) c = null;   // e.g. a point "on" a line it is an end of
        if (c) {
          if (cj.id) c.id = cj.id;
          if (cj.labelOffset   != null) c.labelOffset   = cj.labelOffset;
          if (cj.labelParallel != null) c.labelParallel = cj.labelParallel;
          if (cj.labelAngle    != null) c.labelAngle    = cj.labelAngle;
          if (cj.labelDist     != null) c.labelDist     = cj.labelDist;
          if (cj.labelMidAngle != null) c.labelMidAngle = cj.labelMidAngle;
          if (cj.isDiameter)            c.isDiameter    = true;
          if (cj.driven)                c.driven        = true;
          if (typeof cj.layerId === 'string') c.layerId = cj.layerId;
          if (typeof cj.name === 'string') c.name = cj.name;
          if (typeof cj.expr === 'string' && cj.expr.trim()) c.expr = cj.expr;
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
      for (const l of p.layers) noteId(l.id);
      for (const f of s.fills) noteId(f.id);
      for (const st of s.strokes) { noteId(st.id); noteId(st.group); }
      for (const e of s.entities) walk(e);
      for (const c of s.constraints) noteId(c.id);
    }
    ensureIdAbove(maxN);
    // Shapes filled at creation (older files) become Fill-tool fills.
    for (const s of p.sketches) {
      if (s._legacyFills?.length) s.fills.unshift(...convertLegacyFills(s._legacyFills, s));
      delete s._legacyFills;
    }
    p._mergeSketches(!(Array.isArray(o.layers) && o.layers.length));
    for (const s of p.sketches) for (const st of s.strokes) {
      if (!st.id) st.id = newId('k');
      if (!p.layer(st.layerId)) st.layerId = p.layers[0].id;
    }
    ensureDimensionNames(p);
    p.assignConstraintLayers();
    return p;
  }

  /** The editor works on a single sketch; layers do the grouping. Files
   *  saved with several sketches are merged into the first one. For files
   *  from before layers existed, each former sketch becomes a layer of the
   *  same name so the grouping is kept. Ids are globally unique, so
   *  constraints carry over untouched. */
  _mergeSketches(legacy) {
    if (!this.sketches.length) return;
    const base = this.sketches[0];
    if (this.sketches.length > 1) {
      const wasActive = this.sketches.findIndex(s => s.id === this.activeSketchId);
      if (legacy) {
        this.layers = this.sketches.map((s) => new Layer(s.name, { visible: s.visible }));
        this.activeLayerId = this.layers[Math.max(0, wasActive)].id;
      }
      this.sketches.forEach((s, i) => {
        for (const e of s.entities) {
          if (legacy) e.layerId = this.layers[i].id;
          if (s !== base) { e.sketchId = base.id; base.entities.push(e); }
        }
        if (s !== base) base.constraints.push(...s.constraints);
        if (s !== base) base.features.push(...(s.features || []));
        if (s !== base) base.fills.push(...(s.fills || []));
        if (s !== base) base.strokes.push(...(s.strokes || []));
      });
      this.sketches = [base];
    }
    base.visible = true;          // sketch visibility has no UI any more
    this.activeSketchId = base.id;
  }

  /** Give every constraint without a layer one: the layer of the first
   *  geometry it refers to (older files), else the active layer. */
  assignConstraintLayers() {
    for (const s of this.sketches) {
      let byId = null;
      for (const c of s.constraints) {
        if (c.layerId && this.layer(c.layerId)) continue;
        if (!byId) {
          byId = new Map();
          for (const e of s.entities) { byId.set(e.id, e); for (const ch of e.children()) if (!byId.has(ch.id)) byId.set(ch.id, e); }
        }
        const owner = c.refs().map(id => byId.get(id)).find(Boolean);
        c.layerId = owner ? this.layerOf(owner).id : this.activeLayerId;
      }
    }
  }

  /** Top-level entity that owns e (e itself, or the line / circle / arc a
   *  child point belongs to). */
  ownerOf(e) {
    for (const s of this.sketches) {
      for (const top of s.entities) {
        if (top === e) return top;
        if (top.children().includes(e)) return top;
      }
    }
    return null;
  }
}

// Sketch specs: the drawing format AI assistants write (through the MCP
// server, supabase/functions/mcp), turned into a real OnSketch project.
//
// A spec is small and forgiving where the native file is exact: points
// have names (or are plain [x, y] coordinates, and ends at the same
// place join), shapes refer to points instead of carrying their own, and
// constraints use one name per idea ("tangent", "equal") whatever the
// shapes are. buildFromSpec() checks it, builds the project, solves it
// and says what is wrong in words an assistant can act on.
// projectToSpec() goes the other way, so an assistant can read and change
// a sketch a person drew.
//
// Coordinates are in the drawing's units, x to the right, y UP.
// Angles are in degrees; arcs run counter-clockwise from `from` to `to`
// unless `clockwise` is true.
import { Arc, Circle, Line, Point } from './entities.js';
import { Project } from './model.js';
import { Solver } from './solver.js';
import { DOC_UNITS } from './expr.js';
import {
  AngleConstraint, ArcEndpointArcEndpointCoincidentConstraint, ArcEndpointCoincidentConstraint,
  CollinearConstraint, ConcentricConstraint, DistanceConstraint, EqualLengthConstraint, EqualRadiusConstraint,
  FixConstraint, HorizontalConstraint, MidpointConstraint, ParallelConstraint, PerpendicularConstraint,
  PointLineDistanceConstraint, PointOnCircleConstraint, PointOnLineConstraint, PointRefHorizontalConstraint,
  PointRefVerticalConstraint, RadiusConstraint, SymmetricConstraint, TangentCircleCircleConstraint,
  TangentLineCircleConstraint, VerticalConstraint,
} from './constraints.js';

export const SPEC_VERSION = 1;
export const SPEC_LIMITS = { points: 2000, shapes: 1000, constraints: 2000, coordinate: 1e7 };
export const SHAPE_TYPES = ['line', 'polyline', 'rectangle', 'circle', 'arc', 'point'];
export const CONSTRAINT_TYPES = ['horizontal', 'vertical', 'parallel', 'perpendicular', 'collinear', 'equal',
  'concentric', 'tangent', 'coincident', 'midpoint', 'on', 'symmetric', 'fix', 'distance', 'length',
  'radius', 'diameter', 'angle'];

/** Points closer than this are the same point. */
const JOIN_TOL = 1e-6;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const DEG = Math.PI / 180;

/** The spec can't be built; `problems` lists every reason, one per line. */
export class SpecError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'SpecError';
    this.problems = problems;
  }
}

/**
 * Builds a project from a spec.
 * @returns {{ project: Project, report: { state: 'fully'|'under', dof: number,
 *   shapes: number, constraints: number, warnings: string[] } }}
 * @throws {SpecError} with every problem found
 */
export function buildFromSpec(spec, { title } = {}) {
  const b = new Builder();
  b.read(spec);
  if (b.problems.length) throw new SpecError(b.problems);
  const project = b.realize(title ?? spec?.title);
  if (b.problems.length) throw new SpecError(b.problems);
  const report = b.solve(project);
  if (b.problems.length) throw new SpecError(b.problems);
  return { project, report };
}

class Builder {
  constructor() {
    this.problems = [];
    this.warnings = [];
    this.nodes = [];             // logical points: { x, y, parent, uses:Set }
    this.names = new Map();      // point name / alias → node index
    this.shapes = [];            // { id, type, specIndex, ... }
    this.shapeById = new Map();
    this.cons = [];              // constraint records
    this.units = 'mm';
  }
  bad(msg) { if (this.problems.length < 50) this.problems.push(msg); }

  /* ---- logical points ---- */
  find(i) { while (this.nodes[i].parent !== i) i = this.nodes[i].parent = this.nodes[this.nodes[i].parent].parent; return i; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.nodes[b].parent = a; return a; }
  newNode(x, y) { this.nodes.push({ x, y, parent: this.nodes.length, uses: new Set() }); return this.nodes.length - 1; }
  /** Node at (x, y): an existing one there, or a new one. */
  nodeAt(x, y) {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.parent === i && Math.abs(n.x - x) <= JOIN_TOL && Math.abs(n.y - y) <= JOIN_TOL) return i;
    }
    return this.newNode(x, y);
  }
  coord(v, where) {
    if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) { this.bad(`${where}: expected [x, y] numbers.`); return null; }
    if (v.some(c => Math.abs(c) > SPEC_LIMITS.coordinate)) { this.bad(`${where}: coordinates must stay within ±${SPEC_LIMITS.coordinate}.`); return null; }
    return v;
  }
  /** A point reference: a name, an alias like "outline.tl", or [x, y].
   *  `create`: coordinates that match no point make a new one. */
  point(ref, where, { create = true } = {}) {
    if (typeof ref === 'string') {
      if (this.names.has(ref)) return this.names.get(ref);
      this.bad(`${where}: unknown point "${ref}".${this.hint(ref)}`);
      return null;
    }
    const c = this.coord(ref, where);
    if (!c) return null;
    if (!create) {
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[this.find(i)];
        if (Math.abs(n.x - c[0]) <= JOIN_TOL && Math.abs(n.y - c[1]) <= JOIN_TOL) return this.find(i);
      }
      this.bad(`${where}: no point at [${c[0]}, ${c[1]}]. Refer to points by name, or by the exact coordinates of one.`);
      return null;
    }
    return this.nodeAt(c[0], c[1]);
  }
  hint(ref) {
    const dot = ref.indexOf('.');
    if (dot > 0 && this.shapeById.has(ref.slice(0, dot))) {
      const s = this.shapeById.get(ref.slice(0, dot));
      return ` Points of ${s.type} "${s.id}": ${aliasesOf(s).map(a => `"${s.id}.${a}"`).join(', ')}.`;
    }
    return '';
  }
  alias(name, node) { if (!this.names.has(name)) this.names.set(name, node); }
  shapeName(id, where) {
    if (id == null) return null;
    if (typeof id !== 'string' || !NAME_RE.test(id)) { this.bad(`${where}: id must be a name like "outline" or "hole_1" (letters, digits, _ and -).`); return null; }
    if (this.shapeById.has(id) || this.names.has(id)) { this.bad(`${where}: id "${id}" is used twice.`); return null; }
    return id;
  }
  addShape(rec) {
    this.shapes.push(rec);
    if (rec.id) this.shapeById.set(rec.id, rec);
    return rec;
  }

  /* ---- reading ---- */
  read(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { this.bad('The sketch must be an object with "shapes" (and optionally "points" and "constraints").'); return; }
    if (spec.units != null) {
      if (DOC_UNITS.includes(spec.units)) this.units = spec.units;
      else this.bad(`units: one of ${DOC_UNITS.join(', ')}.`);
    }
    const points = spec.points ?? {};
    if (typeof points !== 'object' || Array.isArray(points)) this.bad('points: an object of name → [x, y].');
    else {
      const entries = Object.entries(points);
      if (entries.length > SPEC_LIMITS.points) this.bad(`points: at most ${SPEC_LIMITS.points}.`);
      for (const [name, v] of entries.slice(0, SPEC_LIMITS.points)) {
        if (!NAME_RE.test(name)) { this.bad(`points.${name}: point names use letters, digits, _ and - (and start with a letter).`); continue; }
        const c = this.coord(v, `points.${name}`);
        if (!c) continue;
        const n = this.nodeAt(c[0], c[1]);
        this.names.set(name, n);
        this.nodes[n].uses.add('declared');
      }
    }
    const shapes = spec.shapes;
    if (!Array.isArray(shapes) || !shapes.length) { this.bad('shapes: a non-empty list of shapes.'); return; }
    if (shapes.length > SPEC_LIMITS.shapes) { this.bad(`shapes: at most ${SPEC_LIMITS.shapes}.`); return; }
    shapes.forEach((s, i) => this.readShape(s, i));
    const cons = spec.constraints ?? [];
    if (!Array.isArray(cons)) { this.bad('constraints: a list.'); return; }
    if (cons.length > SPEC_LIMITS.constraints) { this.bad(`constraints: at most ${SPEC_LIMITS.constraints}.`); return; }
    cons.forEach((c, i) => this.readConstraint(c, i));
  }

  readShape(s, i) {
    const where = `shapes[${i}]` + (s && typeof s.id === 'string' ? ` ("${s.id}")` : '');
    if (!s || typeof s !== 'object') { this.bad(`${where}: a shape object.`); return; }
    const id = this.shapeName(s.id, where);
    if (s.id != null && !id) return;
    const construction = !!s.construction;
    const line = (from, to, lid, w) => {
      const a = this.point(from, `${w}.from`), b = this.point(to, `${w}.to`);
      if (a == null || b == null) return null;
      const rec = this.addShape({ id: lid, type: 'line', a, b, construction, where: w });
      if (lid) { this.alias(`${lid}.start`, a); this.alias(`${lid}.end`, b); }
      return rec;
    };
    switch (s.type) {
      case 'line': line(s.from, s.to, id, where); break;
      case 'polyline': {
        const pts = s.points;
        if (!Array.isArray(pts) || pts.length < 2) { this.bad(`${where}: "points" needs at least 2 points.`); return; }
        const nodes = pts.map((p, k) => this.point(p, `${where}.points[${k}]`));
        if (nodes.some(n => n == null)) return;
        const closed = !!s.closed;
        if (closed && nodes.length < 3) { this.bad(`${where}: a closed polyline needs at least 3 points.`); return; }
        if (id) nodes.forEach((n, k) => this.alias(`${id}.p${k + 1}`, n));
        const segs = nodes.length - (closed ? 0 : 1);
        for (let k = 0; k < segs; k++) {
          const sid = id ? `${id}.s${k + 1}` : null;
          const a = nodes[k], b = nodes[(k + 1) % nodes.length];
          const rec = this.addShape({ id: sid, type: 'line', a, b, construction, where: `${where} segment ${k + 1}` });
          if (sid) { this.shapeById.set(sid, rec); this.alias(`${sid}.start`, a); this.alias(`${sid}.end`, b); }
        }
        if (id) this.groups(id, { type: 'polyline', segments: segs, points: nodes.length });
        break;
      }
      case 'rectangle': {
        const c = this.coord(s.corner ?? (Number.isFinite(s.x) || Number.isFinite(s.y) ? [s.x, s.y] : null), `${where}.corner`);
        const w = s.width, h = s.height;
        if (!(Number.isFinite(w) && w > 0) || !(Number.isFinite(h) && h > 0)) { this.bad(`${where}: "width" and "height" must be positive numbers.`); return; }
        if (!c) return;
        const [x, y] = c;
        const bl = this.nodeAt(x, y), br = this.nodeAt(x + w, y), tr = this.nodeAt(x + w, y + h), tl = this.nodeAt(x, y + h);
        const sides = [['bottom', bl, br, 'horizontal'], ['right', br, tr, 'vertical'], ['top', tr, tl, 'horizontal'], ['left', tl, bl, 'vertical']];
        for (const [name, a, b, dir] of sides) {
          const sid = id ? `${id}.${name}` : null;
          const rec = this.addShape({ id: sid, type: 'line', a, b, construction, where: `${where} ${name}` });
          if (sid) this.shapeById.set(sid, rec);
          this.cons.push({ type: dir, where: `${where} (${dir} ${name} side)`, line: rec, auto: true });
        }
        if (id) {
          Object.entries({ bl, br, tr, tl }).forEach(([k, n]) => this.alias(`${id}.${k}`, n));
          this.groups(id, { type: 'rectangle' });
        }
        break;
      }
      case 'circle': {
        const c = this.point(s.center, `${where}.center`);
        const r = radiusOf(s);
        if (r == null) { this.bad(`${where}: give "r" (radius) or "d" (diameter), a positive number.`); return; }
        if (c == null) return;
        this.addShape({ id, type: 'circle', center: c, r, construction, where });
        if (id) this.alias(`${id}.center`, c);
        break;
      }
      case 'arc': {
        const c = this.point(s.center, `${where}.center`);
        if (c == null) return;
        let a, b;
        if (s.from != null || s.to != null) {
          a = this.point(s.from, `${where}.from`); b = this.point(s.to, `${where}.to`);
          if (a == null || b == null) return;
        } else {
          const r = radiusOf(s);
          if (r == null || !Number.isFinite(s.start_angle) || !Number.isFinite(s.end_angle)) {
            this.bad(`${where}: give "from" and "to" points, or "r" with "start_angle" and "end_angle" (degrees).`); return;
          }
          const C = this.nodes[c];
          a = this.nodeAt(C.x + r * Math.cos(s.start_angle * DEG), C.y + r * Math.sin(s.start_angle * DEG));
          b = this.nodeAt(C.x + r * Math.cos(s.end_angle * DEG), C.y + r * Math.sin(s.end_angle * DEG));
        }
        this.addShape({ id, type: 'arc', center: c, a, b, clockwise: !!s.clockwise, construction, where });
        if (id) { this.alias(`${id}.center`, c); this.alias(`${id}.start`, a); this.alias(`${id}.end`, b); }
        break;
      }
      case 'point': {
        const p = this.point(s.at, `${where}.at`);
        if (p == null) return;
        this.addShape({ id, type: 'point', node: p, construction, where });
        if (id) this.alias(id, p);
        break;
      }
      default:
        this.bad(`${where}: unknown type ${JSON.stringify(s.type)}. Use one of ${SHAPE_TYPES.join(', ')}.`);
    }
  }
  /** Ids that name a group of shapes (a polyline, a rectangle): known,
   *  so a constraint on them gets a helpful message. */
  groups(id, info) { (this.groupIds ??= new Map()).set(id, info); }

  shape(ref, where, kinds) {
    if (typeof ref !== 'string') { this.bad(`${where}: a shape id.`); return null; }
    const s = this.shapeById.get(ref);
    if (!s) {
      const g = this.groupIds?.get(ref);
      if (g?.type === 'rectangle') this.bad(`${where}: "${ref}" is a rectangle; name one side: "${ref}.bottom", "${ref}.right", "${ref}.top" or "${ref}.left".`);
      else if (g?.type === 'polyline') this.bad(`${where}: "${ref}" is a polyline; name one segment: "${ref}.s1" … "${ref}.s${g.segments}".`);
      else if (this.names.has(ref)) this.bad(`${where}: "${ref}" is a point, not a shape.`);
      else this.bad(`${where}: unknown shape "${ref}".`);
      return null;
    }
    if (kinds && !kinds.includes(kindOf(s))) { this.bad(`${where}: "${ref}" is a ${s.type}; expected ${kinds.join(' or ')}.`); return null; }
    return s;
  }
  value(v, where, { min = 0, strict = true, max = Infinity } = {}) {
    if (!Number.isFinite(v) || (strict ? v <= min : v < min) || v > max) {
      this.bad(`${where}: "value" must be a number ${strict ? '>' : '≥'} ${min}${max < Infinity ? ` and ≤ ${max}` : ''}.`);
      return null;
    }
    return v;
  }

  readConstraint(c, i) {
    const where = `constraints[${i}]` + (c && typeof c.type === 'string' ? ` (${c.type})` : '');
    if (!c || typeof c !== 'object') { this.bad(`${where}: a constraint object.`); return; }
    const rec = { type: c.type, where, index: i };
    const P = (k) => this.point(c[k], `${where}.${k}`, { create: false });
    const S = (k, kinds) => this.shape(c[k], `${where}.${k}`, kinds);
    const ok = (...xs) => xs.every(x => x != null);
    switch (c.type) {
      case 'horizontal': case 'vertical':
        if (c.line != null) { rec.line = S('line', ['line']); if (!ok(rec.line)) return; }
        else { rec.a = P('a'); rec.b = P('b'); if (!ok(rec.a, rec.b)) return; }
        break;
      case 'parallel': case 'perpendicular': case 'collinear':
        rec.l1 = S('a', ['line']); rec.l2 = S('b', ['line']); if (!ok(rec.l1, rec.l2)) return;
        break;
      case 'angle':
        rec.l1 = S('a', ['line']); rec.l2 = S('b', ['line']);
        rec.value = this.value(c.value, where, { min: 0, strict: false, max: 180 });
        if (!ok(rec.l1, rec.l2, rec.value)) return;
        break;
      case 'equal': {
        rec.s1 = S('a', ['line', 'round']); rec.s2 = S('b', ['line', 'round']);
        if (!ok(rec.s1, rec.s2)) return;
        if (kindOf(rec.s1) !== kindOf(rec.s2)) { this.bad(`${where}: "equal" ties two lines (same length) or two circles / arcs (same radius), not one of each.`); return; }
        break;
      }
      case 'concentric':
        rec.s1 = S('a', ['round']); rec.s2 = S('b', ['round']); if (!ok(rec.s1, rec.s2)) return;
        break;
      case 'tangent': {
        rec.s1 = S('a', ['line', 'round']); rec.s2 = S('b', ['line', 'round']);
        if (!ok(rec.s1, rec.s2)) return;
        if (kindOf(rec.s1) === 'line' && kindOf(rec.s2) === 'line') { this.bad(`${where}: "tangent" needs at least one circle or arc.`); return; }
        rec.internal = !!c.internal;
        break;
      }
      case 'coincident':
        rec.a = P('a'); rec.b = P('b'); if (!ok(rec.a, rec.b)) return;
        this.union(rec.a, rec.b);
        return;                          // the two become one point: nothing to solve
      case 'midpoint':
        rec.p = P('point'); rec.line = S('line', ['line']); if (!ok(rec.p, rec.line)) return;
        break;
      case 'on':
        rec.p = P('point'); rec.s = S('shape', ['line', 'round']); if (!ok(rec.p, rec.s)) return;
        break;
      case 'symmetric':
        rec.a = P('a'); rec.b = P('b'); rec.axis = S('axis', ['line']); if (!ok(rec.a, rec.b, rec.axis)) return;
        break;
      case 'fix':
        rec.p = P('point'); if (!ok(rec.p)) return;
        break;
      case 'distance': {
        if (c.axis != null && c.axis !== 'x' && c.axis !== 'y') { this.bad(`${where}: "axis" is "x" (horizontal distance) or "y" (vertical distance).`); return; }
        rec.axis = c.axis ?? null;
        rec.value = this.value(c.value, where);
        const isShape = (k) => typeof c[k] === 'string' && this.shapeById.has(c[k]) && !this.names.has(c[k]);
        if (isShape('a') || isShape('b')) {
          const [pk, lk] = isShape('a') ? ['b', 'a'] : ['a', 'b'];
          rec.p = P(pk); rec.line = S(lk, ['line']);
          if (rec.axis) { this.bad(`${where}: "axis" only applies between two points.`); return; }
          if (!ok(rec.p, rec.line, rec.value)) return;
          rec.type = 'pointLine';
        } else {
          rec.a = P('a'); rec.b = P('b'); if (!ok(rec.a, rec.b, rec.value)) return;
        }
        break;
      }
      case 'length':
        rec.line = S('line', ['line']); rec.value = this.value(c.value, where); if (!ok(rec.line, rec.value)) return;
        break;
      case 'radius': case 'diameter':
        rec.s = S('shape', ['round']); rec.value = this.value(c.value, where); if (!ok(rec.s, rec.value)) return;
        break;
      default:
        this.bad(`${where}: unknown type ${JSON.stringify(c.type)}. Use one of ${CONSTRAINT_TYPES.join(', ')}.`);
        return;
    }
    this.cons.push(rec);
  }

  /* ---- building ---- */
  realize(title) {
    const R = (n) => this.find(n);
    // What each point is used for.
    const use = (n, u) => this.nodes[R(n)].uses.add(u);
    this.nodes.forEach((n, i) => { if (R(i) !== i) for (const u of n.uses) this.nodes[R(i)].uses.add(u); });
    for (const s of this.shapes) {
      if (s.type === 'line') { use(s.a, 'end'); use(s.b, 'end'); }
      else if (s.type === 'circle') use(s.center, 'center');
      else if (s.type === 'arc') { use(s.center, 'center'); use(s.a, 'arc'); use(s.b, 'arc'); }
      else if (s.type === 'point') use(s.node, 'point');
    }
    for (const c of this.cons) for (const k of ['a', 'b', 'p']) if (typeof c[k] === 'number') use(c[k], 'ref');
    for (const s of this.shapes) {
      if (s.type === 'line' && R(s.a) === R(s.b)) this.bad(`${s.where}: both ends are the same point.`);
      if (s.type === 'arc') {
        if (R(s.a) === R(s.center) || R(s.b) === R(s.center)) this.bad(`${s.where}: an end is the centre.`);
        if (R(s.a) === R(s.b)) this.bad(`${s.where}: both ends are the same point; use a circle.`);
        else {
          const C = this.nodes[R(s.center)], A = this.nodes[R(s.a)], B = this.nodes[R(s.b)];
          const r1 = Math.hypot(A.x - C.x, A.y - C.y), r2 = Math.hypot(B.x - C.x, B.y - C.y);
          if (Math.abs(r1 - r2) > 1e-3 * Math.max(r1, r2) + 1e-9) {
            this.bad(`${s.where}: "from" is ${fmt(r1)} from the centre and "to" is ${fmt(r2)}; both ends of an arc must be at the same distance (the radius).`);
          }
        }
      }
    }
    if (this.problems.length) return null;

    const project = new Project();
    project.name = cleanTitle(title);
    project.units = this.units;
    project.display = { grid: true, snap: true, dimensions: true, relations: true, dimNames: false };
    const sketch = project.addSketch('Sketch 1');
    this.sketch = sketch;

    // Real points: everything but points only arcs end on.
    const pts = new Map();          // root node → Point
    const ptOf = (n) => {
      const r = R(n);
      if (!pts.has(r)) pts.set(r, new Point(this.nodes[r].x, this.nodes[r].y));
      return pts.get(r);
    };
    const needsPoint = (r) => [...this.nodes[r].uses].some(u => u !== 'arc');
    const owned = new Set();        // roots whose Point belongs to a line / circle / arc centre
    for (const s of this.shapes) {
      let e = null;
      if (s.type === 'line') { e = new Line(ptOf(s.a), ptOf(s.b)); owned.add(R(s.a)); owned.add(R(s.b)); }
      else if (s.type === 'circle') { e = new Circle(ptOf(s.center), s.r); owned.add(R(s.center)); }
      else if (s.type === 'arc') {
        const C = ptOf(s.center), A = this.nodes[R(s.a)], B = this.nodes[R(s.b)];
        const r = Math.hypot(A.x - C.x, A.y - C.y);
        e = new Arc(C, r, Math.atan2(A.y - C.y, A.x - C.x), Math.atan2(B.y - C.y, B.x - C.x));
        e.clockwise = s.clockwise;
        owned.add(R(s.center));
      }
      if (e) { e.construction = s.construction; sketch.addEntity(e); s.entity = e; }
    }
    // Points that stand on their own (declared, a point shape, or only
    // where arcs meet but a constraint needs them).
    for (const [r] of this.nodes.entries()) {
      if (R(r) !== r || owned.has(r) || !needsPoint(r)) continue;
      const p = ptOf(r);
      const asShape = this.shapes.find(s => s.type === 'point' && R(s.node) === r);
      if (asShape) p.construction = asShape.construction;
      sketch.addEntity(p);
    }
    for (const s of this.shapes) if (s.type === 'point') s.entity = ptOf(s.node);
    // Arc ends: tied to the real point there, or to the first arc end there.
    const firstArcEnd = new Map();
    for (const s of this.shapes) {
      if (s.type !== 'arc') continue;
      for (const [n, which] of [[s.a, 'start'], [s.b, 'end']]) {
        const r = R(n);
        const ref = { arcId: s.entity.id, centerId: s.entity.center.id, which };
        if (pts.has(r)) sketch.constraints.push(new ArcEndpointCoincidentConstraint(ref, pts.get(r).id));
        else if (firstArcEnd.has(r)) sketch.constraints.push(new ArcEndpointArcEndpointCoincidentConstraint(firstArcEnd.get(r), ref));
        else firstArcEnd.set(r, ref);
      }
    }
    this.byConstraintId = new Map();
    for (const c of this.cons) {
      const made = this.native(c, ptOf);
      for (const n of made) { sketch.constraints.push(n); this.byConstraintId.set(n.id, c); }
    }
    return project;
  }

  /** The native constraint(s) for one record. */
  native(c, ptOf) {
    const id = (n) => ptOf(n).id;
    const lref = (s) => ({ a: s.entity.p1.id, b: s.entity.p2.id });
    const round = (s) => s.entity;
    switch (c.type) {
      case 'horizontal': case 'vertical': {
        if (c.line) {
          const l = c.line.entity;
          return [c.type === 'horizontal' ? new HorizontalConstraint(l.id, l.p1.id, l.p2.id) : new VerticalConstraint(l.id, l.p1.id, l.p2.id)];
        }
        const r1 = { pointId: id(c.a) }, r2 = { pointId: id(c.b) };
        return [c.type === 'horizontal' ? new PointRefHorizontalConstraint(r1, r2) : new PointRefVerticalConstraint(r1, r2)];
      }
      case 'parallel': return [new ParallelConstraint(lref(c.l1), lref(c.l2))];
      case 'perpendicular': return [new PerpendicularConstraint(lref(c.l1), lref(c.l2))];
      case 'collinear': return [new CollinearConstraint(lref(c.l1), lref(c.l2))];
      case 'angle': {
        const value = c.value * DEG;
        const l1 = lref(c.l1);
        let l2 = lref(c.l2);
        // Measure between the directions that make the drawn angle closest
        // to the asked one (60° and 120° are different dimensions).
        const at = lookup(this.sketch);
        const m = AngleConstraint.measure(at, l1, l2);
        if (m != null && Math.abs(Math.PI - m - value) < Math.abs(m - value)) l2 = { a: l2.b, b: l2.a };
        return [new AngleConstraint(l1, l2, value)];
      }
      case 'equal':
        return [kindOf(c.s1) === 'line' ? new EqualLengthConstraint(lref(c.s1), lref(c.s2)) : new EqualRadiusConstraint(round(c.s1).id, round(c.s2).id)];
      case 'concentric': return [new ConcentricConstraint(round(c.s1).center.id, round(c.s2).center.id)];
      case 'tangent': {
        const [l, o] = kindOf(c.s1) === 'line' ? [c.s1, c.s2] : kindOf(c.s2) === 'line' ? [c.s2, c.s1] : [null, null];
        if (l) return [new TangentLineCircleConstraint(lref(l), round(o).id, round(o).center.id)];
        const a = round(c.s1), b = round(c.s2);
        return [new TangentCircleCircleConstraint(a.id, a.center.id, b.id, b.center.id, c.internal)];
      }
      case 'midpoint': return [new MidpointConstraint(id(c.p), lref(c.line))];
      case 'on':
        return [kindOf(c.s) === 'line' ? new PointOnLineConstraint(id(c.p), lref(c.s))
          : new PointOnCircleConstraint(id(c.p), round(c.s).id, round(c.s).center.id)];
      case 'symmetric': return [new SymmetricConstraint(id(c.a), id(c.b), lref(c.axis), 'p1')];
      case 'fix': { const p = ptOf(c.p); return [new FixConstraint(p.id, p.x, p.y)]; }
      case 'distance': return [new DistanceConstraint(id(c.a), id(c.b), c.value, c.axis)];
      case 'pointLine': return [new PointLineDistanceConstraint(id(c.p), lref(c.line), c.value)];
      case 'length': return [new DistanceConstraint(c.line.entity.p1.id, c.line.entity.p2.id, c.value)];
      case 'radius': case 'diameter': {
        const k = new RadiusConstraint(round(c.s).id, c.type === 'diameter' ? c.value / 2 : c.value);
        if (c.type === 'diameter') k.isDiameter = true;
        return [k];
      }
    }
    return [];
  }

  /* ---- solving ---- */
  solve(project) {
    const sketch = project.active();
    const before = snapshot(sketch);
    const r = new Solver().solve(sketch, [sketch], [], { diagnostics: true });
    for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
    const blame = (ids) => {
      const out = new Set();
      for (const id of ids || []) { const rec = this.byConstraintId.get(id); if (rec) out.add(rec.where); }
      return [...out];
    };
    if (!r.ok || r.residual > 1e-6) {
      const who = blame(r.redundantIds);
      this.bad('The constraints cannot all be met at once (they contradict each other, or the sizes are impossible).'
        + (who.length ? ` Check: ${who.join('; ')}.` : ''));
      return null;
    }
    if (r.state === 'over' || r.redundant > 0) {
      const who = blame(r.redundantIds);
      this.bad('Some constraints repeat what others already fix (over-defined; OnSketch shows these in red).'
        + (who.length ? ` Remove one of: ${who.join('; ')}.` : ''));
      return null;
    }
    if (r.collapsed?.size) {
      this.bad('Solving shrank a line to nothing or a circle to a point; check the sizes and the constraints on it.');
      return null;
    }
    // Large moves usually mean the coordinates and constraints disagree.
    const after = snapshot(sketch);
    const size = extent(before) || 1;
    let moved = 0;
    for (const [id, p] of before) {
      const q = after.get(id);
      if (q) moved = Math.max(moved, Math.hypot(q.x - p.x, q.y - p.y));
    }
    if (moved > 0.2 * size) {
      this.warnings.push(`Solving moved some points by up to ${fmt(moved)} (the drawing is about ${fmt(size)} across): the coordinates and the constraints disagreed. Check the result looks as intended.`);
    }
    if (r.state === 'under') {
      this.warnings.push(`${r.dof} degree${r.dof === 1 ? '' : 's'} of freedom left: the sketch is not fully defined (fine for a drawing; add dimensions or "fix" a point to lock it).`);
    }
    const userCons = this.cons.filter(c => !c.auto).length;
    return {
      state: r.state === 'fully' ? 'fully' : 'under', dof: r.dof ?? 0,
      shapes: sketch.entities.length, constraints: userCons, warnings: this.warnings,
    };
  }
}

/* ---- helpers ---- */
function radiusOf(s) {
  if (Number.isFinite(s.r) && s.r > 0) return s.r;
  if (Number.isFinite(s.d) && s.d > 0) return s.d / 2;
  return null;
}
function kindOf(s) { return s.type === 'line' ? 'line' : (s.type === 'circle' || s.type === 'arc') ? 'round' : s.type; }
function aliasesOf(s) {
  if (s.type === 'line') return ['start', 'end'];
  if (s.type === 'arc') return ['center', 'start', 'end'];
  if (s.type === 'circle') return ['center'];
  return [];
}
const fmt = (v) => String(Math.round(v * 1000) / 1000);
export function cleanTitle(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || 'Untitled';
}
function lookup(sketch) {
  const byId = new Map();
  const walk = (e) => { byId.set(e.id, e); for (const c of e.children()) walk(c); };
  for (const e of sketch.entities) walk(e);
  return (id, k) => byId.get(id)?.[k] ?? 0;
}
function snapshot(sketch) {
  const out = new Map();
  const walk = (e) => { if (e instanceof Point) out.set(e.id, { x: e.x, y: e.y }); for (const c of e.children()) walk(c); };
  for (const e of sketch.entities) walk(e);
  return out;
}
function extent(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return Number.isFinite(x0) ? Math.max(x1 - x0, y1 - y0) : 0;
}

/* =============== NATIVE → SPEC ================================= */
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Describes a project as a spec, so an assistant can read it and send a
 * changed copy back. `lossless` is false when the project holds things a
 * spec can't (curves, ink, text, fills, patterns, formulas…): replacing
 * such a sketch from its spec would lose them; `unsupported` says what.
 */
export function projectToSpec(project) {
  const sketch = project.active() || project.sketches[0];
  const unsupported = new Set();
  const spec = { units: project.units || 'mm', points: {}, shapes: [], constraints: [] };
  if (!sketch) return { spec, lossless: true, unsupported: [] };
  if (sketch.strokes?.length) unsupported.add('ink, text, arrows or pictures');
  if (sketch.fills?.length) unsupported.add('fills');
  if (project.variables?.length) unsupported.add('variables');
  if (project.layers.length > 1) unsupported.add('layers');

  const pointName = new Map();     // Point id → spec name
  const nameOf = (p) => {
    if (!pointName.has(p.id)) {
      const name = p.id;
      pointName.set(p.id, name);
      spec.points[name] = [r6(p.x), r6(p.y)];
    }
    return pointName.get(p.id);
  };
  const arcEnd = new Map();        // `${arcId}.${which}` → point name it is tied to
  for (const c of sketch.constraints) {
    if (c.kind === 'arcEndpointCoincident') arcEnd.set(`${c.ref.arcId}.${c.ref.which}`, c.pointId);
  }
  const all = new Map();
  for (const e of sketch.entities) { all.set(e.id, e); for (const ch of e.children()) all.set(ch.id, ch); }
  const shapeIds = new Set();
  for (const e of sketch.entities) {
    const base = { id: e.id, ...(e.construction ? { construction: true } : {}) };
    if (e instanceof Line) spec.shapes.push({ ...base, type: 'line', from: nameOf(e.p1), to: nameOf(e.p2) });
    else if (e instanceof Circle) spec.shapes.push({ ...base, type: 'circle', center: nameOf(e.center), r: r6(e.r) });
    else if (e instanceof Arc) {
      e.syncEnds();
      const end = (which, p) => {
        const tied = arcEnd.get(`${e.id}.${which}`);
        return tied && all.get(tied) ? nameOf(all.get(tied)) : [r6(p.x), r6(p.y)];
      };
      spec.shapes.push({ ...base, type: 'arc', center: nameOf(e.center), from: end('start', e.start), to: end('end', e.end), ...(e.clockwise ? { clockwise: true } : {}) });
    } else if (e instanceof Point) spec.shapes.push({ type: 'point', at: nameOf(e), ...(e.construction ? { construction: true } : {}) });
    else { unsupported.add('curves'); continue; }
    shapeIds.add(e.id);
  }
  // A point refers to its spec name; an arc end to the arc's alias.
  const P = (id) => pointName.get(id) ?? (all.get(id) ? nameOf(all.get(id)) : null);
  const arcRefName = (ref) => {
    const tied = arcEnd.get(`${ref.arcId}.${ref.which}`);
    return tied ? P(tied) : `${ref.arcId}.${ref.which}`;
  };
  const lineOf = (l) => {
    for (const e of sketch.entities) {
      if (e instanceof Line && ((e.p1.id === l.a && e.p2.id === l.b) || (e.p1.id === l.b && e.p2.id === l.a))) return e.id;
    }
    return null;
  };
  const roundOfCenter = (centerId) => sketch.entities.find(e => (e instanceof Circle || e instanceof Arc) && e.center.id === centerId)?.id ?? null;
  const out = (o) => { if (Object.values(o).every(v => v != null)) spec.constraints.push(o); else unsupported.add(`a ${o.type} constraint`); };
  for (const c of sketch.constraints) {
    if (c.driven) continue;                               // reference dimensions: shown, not solved
    if (c.expr) unsupported.add('formulas on dimensions');
    switch (c.kind) {
      case 'arcEndpointCoincident': break;                // expressed through the arc's from / to
      case 'arcEndpointArcEndpointCoincident': out({ type: 'coincident', a: arcRefName(c.ref1), b: arcRefName(c.ref2) }); break;
      case 'coincident': out({ type: 'coincident', a: P(c.p1), b: P(c.p2) }); break;
      case 'horizontal': case 'vertical': out({ type: c.kind, line: c.lineId }); break;
      case 'pointRefHorizontal': case 'pointRefVertical':
        out({ type: c.kind === 'pointRefHorizontal' ? 'horizontal' : 'vertical', a: c.ref1.pointId ? P(c.ref1.pointId) : arcRefName(c.ref1), b: c.ref2.pointId ? P(c.ref2.pointId) : arcRefName(c.ref2) });
        break;
      case 'parallel': case 'perpendicular': case 'collinear': out({ type: c.kind, a: lineOf(c.l1), b: lineOf(c.l2) }); break;
      case 'angle': out({ type: 'angle', a: lineOf(c.l1), b: lineOf(c.l2), value: r6(c.value / DEG) }); break;
      case 'equalLength': out({ type: 'equal', a: lineOf(c.l1), b: lineOf(c.l2) }); break;
      case 'equalRadius': out({ type: 'equal', a: c.c1, b: c.c2 }); break;
      case 'concentric': out({ type: 'concentric', a: roundOfCenter(c.p1), b: roundOfCenter(c.p2) }); break;
      case 'tangent':
        if ('l' in c) out({ type: 'tangent', a: lineOf(c.l), b: c.circleId });
        else out({ type: 'tangent', a: c.c1, b: c.c2, ...(c.internal ? { internal: true } : {}) });
        break;
      case 'midpoint': out({ type: 'midpoint', point: P(c.pointId), line: lineOf(c.l) }); break;
      case 'arcEndpointMidpoint': out({ type: 'midpoint', point: arcRefName(c.ref), line: lineOf(c.l) }); break;
      case 'pointOnLine': out({ type: 'on', point: P(c.pointId), shape: lineOf(c.l) }); break;
      case 'arcEndpointOnLine': out({ type: 'on', point: arcRefName(c.ref), shape: lineOf(c.l) }); break;
      case 'pointOnCircle': out({ type: 'on', point: P(c.pointId), shape: c.circleId }); break;
      case 'arcEndpointOnCircle': out({ type: 'on', point: arcRefName(c.ref), shape: c.circleId }); break;
      case 'symmetric': out({ type: 'symmetric', a: P(c.p1), b: P(c.p2), axis: lineOf(c.axis) }); break;
      case 'fix': out({ type: 'fix', point: P(c.pointId) }); break;
      case 'arcEndpointFix': out({ type: 'fix', point: arcRefName(c.ref) }); break;
      case 'distance': out({ type: 'distance', a: P(c.p1), b: P(c.p2), value: r6(c.value), ...(c.axis ? { axis: c.axis } : {}) }); break;
      case 'pointLineDistance': out({ type: 'distance', a: P(c.pointId), b: lineOf(c.l), value: r6(c.value) }); break;
      case 'radius': out(c.isDiameter ? { type: 'diameter', shape: c.circleId, value: r6(c.value * 2) } : { type: 'radius', shape: c.circleId, value: r6(c.value) }); break;
      default: unsupported.add(`${c.kind} constraints`);
    }
  }
  // Two lines joined at a point share its name already; a distance on a
  // line's own ends reads better as a length.
  for (const k of spec.constraints) {
    if (k.type === 'distance' && !k.axis) {
      const l = sketch.entities.find(e => e instanceof Line && [P(e.p1.id), P(e.p2.id)].sort().join() === [k.a, k.b].sort().join());
      if (l && shapeIds.has(l.id)) { k.type = 'length'; k.line = l.id; delete k.a; delete k.b; }
    }
  }
  return { spec, lossless: unsupported.size === 0, unsupported: [...unsupported] };
}

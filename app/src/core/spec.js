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
import { Arc, Bezier, Circle, Line, Point } from './entities.js';
import { Project } from './model.js';
import { Solver } from './solver.js';
import { DOC_UNITS, NAME_RE as VAR_RE, isReservedName, evaluate } from './expr.js';
import { ensureDimensionNames, solveEquations, internalValue, userValue, measureDrivenDimensions, allDimensions, isDimension } from './equations.js';
import { readPresentation, applyLayers, applyDrawing, presentationToSpec } from './spec-drawing.js';
import {
  AngleConstraint, ArcEndpointArcEndpointCoincidentConstraint, ArcEndpointCoincidentConstraint,
  CollinearConstraint, ConcentricConstraint, DistanceConstraint, EqualLengthConstraint, EqualRadiusConstraint,
  FixConstraint, HorizontalConstraint, MidpointConstraint, ParallelConstraint, PerpendicularConstraint,
  PointLineDistanceConstraint, PointOnCircleConstraint, PointOnLineConstraint, PointRefHorizontalConstraint,
  PointRefVerticalConstraint, RadiusConstraint, SymmetricConstraint, TangentCircleCircleConstraint,
  TangentLineCircleConstraint, VerticalConstraint, DirectedAngleConstraint, CurveDistanceConstraint,
  OffsetConstraint, OffsetDistanceConstraint, ParamFixConstraint, SmoothConstraint, PointOnCurveConstraint,
  CurveTangentConstraint,
} from './constraints.js';
import { PatternConstraint, cleanPatternParams, syncPattern, PATTERN_MAX_COPIES } from './patterns.js';

export const SPEC_VERSION = 1;
export const SPEC_LIMITS = { points: 2000, shapes: 1000, constraints: 2000, coordinate: 1e7 };
export const SHAPE_TYPES = ['line', 'polyline', 'rectangle', 'circle', 'arc', 'curve', 'polygon', 'point', 'mirror', 'pattern'];
export const CONSTRAINT_TYPES = ['horizontal', 'vertical', 'parallel', 'perpendicular', 'collinear', 'equal',
  'concentric', 'tangent', 'coincident', 'midpoint', 'on', 'symmetric', 'fix', 'distance', 'length',
  'radius', 'diameter', 'angle', 'smooth', 'offset'];
/** Constraints that can be "reference": shown and measured, not solved. */
const DRIVABLE = new Set(['distance', 'pointLine', 'length', 'radius', 'diameter', 'angle', 'roundDistance', 'equal', 'offset']);

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
export function buildFromSpec(spec, { title, images } = {}) {
  const b = new Builder();
  b.images = images || null;              // id → data URL of pictures already in the sketch ("image:<id>")
  b.read(spec);
  if (b.problems.length) throw new SpecError(b.problems);
  const project = b.realize(title ?? spec?.title);
  if (b.problems.length) throw new SpecError(b.problems);
  const report = b.solve(project);
  if (b.problems.length) throw new SpecError(b.problems);
  measureDrivenDimensions(project.active());  // reference dimensions show what is there
  b.placeSliders(project);
  applyDrawing(b, project);                 // text, arrows, ink, fills: on the solved geometry
  if (b.problems.length) throw new SpecError(b.problems);
  report.drawing = project.active().strokes.length;
  report.fills = project.active().fills.length;
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
    rec.look = this.look;
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
    this.readVariables(spec.variables);
    if (spec.display != null) {
      const d = spec.display, keys = { grid: 'grid', snap: 'snap', dimensions: 'dimensions', relations: 'relations', names: 'dimNames' };
      if (typeof d !== 'object' || Array.isArray(d) || Object.entries(d).some(([k, v]) => !(k in keys) || typeof v !== 'boolean')) {
        this.bad(`display: { ${Object.keys(keys).map(k => `"${k}": true | false`).join(', ')} } (what the editor shows).`);
      } else this.display = Object.fromEntries(Object.entries(d).map(([k, v]) => [keys[k], v]));
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
        // Each name is its own point (two names at one place are two
        // points); plain [x, y] coordinates join whatever point is there.
        const n = this.newNode(c[0], c[1]);
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
    readPresentation(this, spec);
  }

  readShape(s, i) {
    const where = `shapes[${i}]` + (s && typeof s.id === 'string' ? ` ("${s.id}")` : '');
    if (!s || typeof s !== 'object') { this.bad(`${where}: a shape object.`); return; }
    const id = this.shapeName(s.id, where);
    if (s.id != null && !id) return;
    const construction = !!s.construction;
    this.look = { layer: s.layer, line_style: s.line_style, weight: s.weight };
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
        const members = [];
        for (let k = 0; k < segs; k++) {
          const sid = id ? `${id}.s${k + 1}` : null;
          const a = nodes[k], b = nodes[(k + 1) % nodes.length];
          const rec = this.addShape({ id: sid, type: 'line', a, b, construction, where: `${where} segment ${k + 1}` });
          members.push(rec);
          if (sid) { this.shapeById.set(sid, rec); this.alias(`${sid}.start`, a); this.alias(`${sid}.end`, b); }
        }
        if (id) this.groups(id, { type: 'polyline', segments: segs, points: nodes.length }, members);
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
        const members = [];
        for (const [name, a, b, dir] of sides) {
          const sid = id ? `${id}.${name}` : null;
          const rec = this.addShape({ id: sid, type: 'line', a, b, construction, where: `${where} ${name}` });
          members.push(rec);
          if (sid) this.shapeById.set(sid, rec);
          this.cons.push({ type: dir, where: `${where} (${dir} ${name} side)`, line: rec, auto: true });
        }
        if (id) {
          Object.entries({ bl, br, tr, tl }).forEach(([k, n]) => this.alias(`${id}.${k}`, n));
          this.groups(id, { type: 'rectangle' }, members);
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
      case 'curve': this.readCurve(s, id, construction, where); break;
      case 'polygon': this.readPolygon(s, id, construction, where); break;
      case 'mirror': this.readMirror(s, id, where); break;
      case 'pattern': this.readPattern(s, id, where); break;
      default:
        this.bad(`${where}: unknown type ${JSON.stringify(s.type)}. Use one of ${SHAPE_TYPES.join(', ')}.`);
    }
  }
  /** Ids that name a group of shapes (a polyline, a rectangle): known,
   *  so a constraint on them gets a helpful message. */
  groups(id, info, members = []) { (this.groupIds ??= new Map()).set(id, { ...info, members }); }
  /** The shapes an id stands for: one shape, or a group's members. */
  members(ref, where) {
    if (this.shapeById.has(ref)) return [this.shapeById.get(ref)];
    const g = this.groupIds?.get(ref);
    if (g) return g.members;
    this.shape(ref, where);                      // its message says what is wrong
    return null;
  }
  /** Global variables: name → number, formula, or { "value", "slider" }. */
  readVariables(vars) {
    this.variables = [];
    if (vars == null) return;
    if (typeof vars !== 'object' || Array.isArray(vars)) { this.bad('variables: an object of name → number or formula ("width / 2").'); return; }
    for (const [name, v] of Object.entries(vars)) {
      const where = `variables.${name}`;
      if (!VAR_RE.test(name) || isReservedName(name)) { this.bad(`${where}: variable names use letters, digits and _, start with a letter, and aren't function names (sin, sqrt, pi…).`); continue; }
      const o = v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
      const val = o.value;
      if (!(Number.isFinite(val) || (typeof val === 'string' && val.trim()))) { this.bad(`${where}: a number or a formula.`); continue; }
      let slider = null;
      if (o.slider != null && o.slider !== false) {
        const sl = o.slider === true ? {} : o.slider;
        if (typeof sl !== 'object' || ['min', 'max', 'step'].some(k => sl[k] != null && !Number.isFinite(sl[k])) || (sl.step != null && !(sl.step > 0))) { this.bad(`${where}: "slider" is true or { "min", "max", "step" }.`); continue; }
        if (typeof val === 'string' && !/^\s*-?\d+(\.\d+)?\s*$/.test(val)) { this.bad(`${where}: a slider needs a plain number, not a formula.`); continue; }
        slider = sl;
      }
      this.variables.push({ name, expr: String(val).trim(), slider, where });
    }
  }

  /** Variables and formulas, as the editor's Equations window does it:
   *  values written into the dimensions before solving. */
  applyEquations(project) {
    project.variables = this.variables.map(v => ({ name: v.name, expr: v.expr }));
    const taken = new Set(this.variables.map(v => v.name));
    for (const c of project.active().constraints) {
      if (!c.name) continue;
      if (taken.has(c.name)) this.bad(`${this.byConstraintId.get(c.id)?.where || 'constraints'}: the name "${c.name}" is used twice (dimension names and variables share one list).`);
      taken.add(c.name);
    }
    if (this.problems.length) return;
    ensureDimensionNames(project);
    solveEquations(project, (c, v) => {
      if (c.kind === 'offsetDistance') {
        c.value = Math.abs(v);
        for (const p of c.pairs) p.value = (p.value < 0 ? -1 : 1) * Math.abs(v);
      } else c.value = internalValue(c, v);
    });
    for (const v of project.variables) {
      if (v.error) this.bad(`variables.${v.name}: ${v.error}.`);
      delete v.value; delete v.error;
    }
    for (const c of allDimensions(project)) {
      if (c.exprError) this.bad(`${this.byConstraintId.get(c.id)?.where || 'constraints'}: formula "${c.expr}": ${c.exprError}.`);
      delete c.exprError;
    }
    // Pattern counts and spacings given as formulas.
    const values = new Map(this.variables.map(v => [v.name, null]));
    const lookup = (name) => {
      if (values.get(name) != null) return values.get(name);
      const dim = allDimensions(project).find(c => c.name === name);
      if (dim) return userValue(dim);
      const v = project.variables.find(x => x.name === name);
      if (v) { const x = evaluate(v.expr, lookup); values.set(name, x); return x; }
      return undefined;
    };
    for (const pt of this.patterns || []) {
      for (const [path, expr] of Object.entries(pt.exprs || {})) {
        let x;
        try { x = evaluate(expr, lookup); } catch (e) { this.bad(`${pt.where}: formula "${expr}": ${e.message}.`); continue; }
        const [a, b] = path.split('.');
        const target = b ? pt[a] : pt;
        const key = b || a;
        if (/count/.test(key)) {
          if (!(Number.isFinite(x) && Math.round(x) >= 1)) { this.bad(`${pt.where}: "${expr}" gives ${x}, not a count.`); continue; }
          x = Math.round(x);
        }
        target[key] = x;
      }
    }
  }

  /** Bézier curves: one ({ from, to, c1, c2 }) or a smooth path through points. */
  readCurve(s, id, construction, where) {
    const xy = (n) => this.nodes[this.find(n)];
    if (Array.isArray(s.points)) {
      const pts = s.points;
      const closed = !!s.closed;
      if (pts.length < (closed ? 3 : 2)) { this.bad(`${where}: "points" needs at least ${closed ? 3 : 2} points.`); return; }
      const nodes = pts.map((p, k) => this.point(p, `${where}.points[${k}]`));
      if (nodes.some(n => n == null)) return;
      const n = nodes.length, P = (k) => xy(nodes[closed ? (k + n) % n : Math.max(0, Math.min(n - 1, k))]);
      const segs = closed ? n : n - 1;
      const members = [];
      for (let k = 0; k < segs; k++) {
        // Catmull-Rom tangents: a smooth curve through every point.
        const p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2);
        const h1 = [p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6];
        const h2 = [p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6];
        const sid = id ? `${id}.s${k + 1}` : null;
        const rec = this.addShape({ id: sid, type: 'curve', a: nodes[k], b: nodes[(k + 1) % n], h1, h2, construction, where: `${where} segment ${k + 1}` });
        members.push(rec);
        if (sid) { this.shapeById.set(sid, rec); this.alias(`${sid}.start`, rec.a); this.alias(`${sid}.end`, rec.b); }
      }
      if (s.smooth !== false) {
        const joints = closed ? nodes : nodes.slice(1, -1);
        for (const j of joints) this.cons.push({ type: 'smooth', where: `${where} (smooth joint)`, p: j, auto: true });
      }
      if (id) { nodes.forEach((nd, k) => this.alias(`${id}.p${k + 1}`, nd)); this.groups(id, { type: 'curve path', segments: segs }, members); }
      return;
    }
    const a = this.point(s.from, `${where}.from`), b = this.point(s.to, `${where}.to`);
    const h1 = this.coord(s.c1, `${where}.c1`), h2 = this.coord(s.c2, `${where}.c2`);
    if (a == null || b == null || !h1 || !h2) {
      if (a != null && b != null) this.bad(`${where}: a curve is { "from", "to", "c1", "c2" } (c1 / c2: handle positions [x, y]) or { "points": [...] } for a smooth path through points.`);
      return;
    }
    this.addShape({ id, type: 'curve', a, b, h1, h2, construction, where });
    if (id) { this.alias(`${id}.start`, a); this.alias(`${id}.end`, b); }
  }

  /** Regular polygon, as the Polygon tool makes it: sides on a
   *  construction circle, equal, at equal angles round the centre. */
  readPolygon(s, id, construction, where) {
    const c = this.point(s.center, `${where}.center`);
    const n = s.sides;
    if (!Number.isInteger(n) || n < 3 || n > 64) { this.bad(`${where}: "sides" is a whole number from 3 to 64.`); return; }
    let r = Number.isFinite(s.r) && s.r > 0 ? s.r : null;
    if (r == null && Number.isFinite(s.side) && s.side > 0) r = s.side / (2 * Math.sin(Math.PI / n));
    if (r == null) { this.bad(`${where}: give "r" (centre to corner) or "side" (side length).`); return; }
    if (s.angle != null && !Number.isFinite(s.angle)) { this.bad(`${where}: "angle" is where the first corner is, in degrees (default 90: a corner at the top).`); return; }
    if (c == null) return;
    const C = this.nodes[this.find(c)], a0 = (s.angle ?? 90) * DEG;
    const verts = Array.from({ length: n }, (_, k) => this.nodeAt(C.x + r * Math.cos(a0 + k * 2 * Math.PI / n), C.y + r * Math.sin(a0 + k * 2 * Math.PI / n)));
    const circle = this.addShape({ id: id ? `${id}.circle` : null, type: 'circle', center: c, r, construction: true, where: `${where} circle` });
    if (id) this.shapeById.set(`${id}.circle`, circle);
    const members = [];
    for (let k = 0; k < n; k++) {
      const sid = id ? `${id}.s${k + 1}` : null;
      const rec = this.addShape({ id: sid, type: 'line', a: verts[k], b: verts[(k + 1) % n], construction, where: `${where} side ${k + 1}` });
      members.push(rec);
      if (sid) { this.shapeById.set(sid, rec); this.alias(`${sid}.start`, rec.a); this.alias(`${sid}.end`, rec.b); }
    }
    for (const v of verts) this.cons.push({ type: 'on', where: `${where} (corner on its circle)`, p: v, s: circle, auto: true });
    for (let k = 1; k < n; k++) this.cons.push({ type: 'equal', where: `${where} (equal sides)`, s1: members[0], s2: members[k], reference: true, auto: true });
    for (let k = 0; k < n - 1; k++) {
      this.cons.push({ type: 'angle', signed: true, where: `${where} (equal angles)`, p1: [c, verts[k]], p2: [c, verts[k + 1]], value: 360 / n, auto: true });
    }
    if (id) { this.alias(`${id}.center`, c); verts.forEach((v, k) => this.alias(`${id}.p${k + 1}`, v)); this.groups(id, { type: 'polygon', segments: n }, members); }
  }

  /** Mirror copies of shapes about a line, tied to them by symmetry. */
  readMirror(s, id, where) {
    if (!Array.isArray(s.of) || !s.of.length) { this.bad(`${where}: "of" lists the shapes to mirror (ids).`); return; }
    const axis = this.shape(s.axis, `${where}.axis`, ['line']);
    const seeds = [];
    for (const [k, ref] of s.of.entries()) {
      const m = typeof ref === 'string' ? this.members(ref, `${where}.of[${k}]`) : (this.bad(`${where}.of[${k}]: a shape id.`), null);
      if (m) for (const r of m) if (!seeds.includes(r)) seeds.push(r);
    }
    if (!axis || !seeds.length) return;
    const A = this.nodes[this.find(axis.a)], B = this.nodes[this.find(axis.b)];
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    if (L2 < 1e-18) { this.bad(`${where}: the axis has no length.`); return; }
    const reflect = (x, y) => { const t = ((x - A.x) * dx + (y - A.y) * dy) / L2; const fx = A.x + t * dx, fy = A.y + t * dy; return [2 * fx - x, 2 * fy - y]; };
    const size = Math.sqrt(L2);
    const map = new Map();
    const mirror = (n) => {
      const r = this.find(n);
      if (map.has(r)) return map.get(r);
      const N = this.nodes[r], [x, y] = reflect(N.x, N.y);
      const on = Math.hypot(x - N.x, y - N.y) < 1e-9 * Math.max(1, size);
      const m = on ? r : this.nodeAt(x, y);
      map.set(r, m);
      if (!on) this.cons.push({ type: 'symmetric', where: `${where} (mirrored point)`, a: r, b: m, axis, auto: true });
      return m;
    };
    const members = [];
    for (const seed of seeds) {
      const cid = id && seed.id ? `${id}.${seed.id}` : null;
      const base = { id: cid, construction: seed.construction, where: `${where} copy of ${seed.id || seed.where}`, look: seed.look };
      let rec = null;
      if (seed.type === 'line') rec = { ...base, type: 'line', a: mirror(seed.a), b: mirror(seed.b) };
      else if (seed.type === 'point') rec = { ...base, type: 'point', node: mirror(seed.node) };
      else if (seed.type === 'circle') {
        rec = { ...base, type: 'circle', center: mirror(seed.center), r: seed.r };
        this.cons.push({ type: 'equal', where: `${where} (same radius)`, s1: seed, s2: rec, auto: true });
      } else if (seed.type === 'arc') {
        // ends mirrored (tied by symmetry) and the same radius: the arc is defined
        // its own centre point (sharing one on the axis would make the radius twice defined)
        const C = this.nodes[this.find(seed.center)];
        rec = { ...base, type: 'arc', center: this.newNode(...reflect(C.x, C.y)), a: mirror(seed.b), b: mirror(seed.a), clockwise: seed.clockwise };
        this.cons.push({ type: 'equal', where: `${where} (same radius)`, s1: seed, s2: rec, auto: true });
      } else if (seed.type === 'curve') {
        rec = { ...base, type: 'curve', a: mirror(seed.a), b: mirror(seed.b), h1: reflect(...seed.h1), h2: reflect(...seed.h2), mirrorOf: { seed, axis } };
      }
      if (!rec) continue;
      this.shapes.push(rec);
      members.push(rec);
      if (cid) {
        this.shapeById.set(cid, rec);
        if (rec.type === 'line' || rec.type === 'arc' || rec.type === 'curve') { this.alias(`${cid}.start`, rec.a); this.alias(`${cid}.end`, rec.b); }
        if (rec.center != null) this.alias(`${cid}.center`, rec.center);
        if (rec.type === 'point') this.alias(cid, rec.node);
      }
    }
    if (id) this.groups(id, { type: 'mirror' }, members);
  }

  /** Linear, circular or point patterns: copies kept in step with their seeds. */
  readPattern(s, id, where) {
    if (!['linear', 'circular', 'points'].includes(s.kind)) { this.bad(`${where}: "kind" is "linear", "circular" or "points".`); return; }
    if (!Array.isArray(s.of) || !s.of.length) { this.bad(`${where}: "of" lists the shapes to repeat (ids).`); return; }
    const seeds = [];
    for (const [k, ref] of s.of.entries()) {
      const m = typeof ref === 'string' ? this.members(ref, `${where}.of[${k}]`) : (this.bad(`${where}.of[${k}]: a shape id.`), null);
      if (m) for (const r of m) if (!seeds.includes(r)) seeds.push(r);
    }
    const count = (v, key, min = 1) => {
      if (v == null) return 1;
      if (!Number.isInteger(v) || v < min || v > PATTERN_MAX_COPIES + 1) { this.bad(`${where}: "${key}" is a whole number from ${min} to ${PATTERN_MAX_COPIES + 1} (the seed counts as one).`); return null; }
      return v;
    };
    // Formulas for counts, spacings and angles: placeholders now, evaluated with the variables.
    const PATHS = s.kind === 'linear'
      ? { count: 'd1.count', spacing: 'd1.spacing', angle: 'd1.angle', count2: 'd2.count', spacing2: 'd2.spacing', angle2: 'd2.angle' }
      : { count: 'count', total_angle: 'angle' };
    const exprs = {};
    s = { ...s };
    for (const [k, path] of Object.entries(PATHS)) {
      if (typeof s[k] === 'string' && s[k].trim()) { exprs[path] = s[k].trim(); s[k] = /count/.test(k) ? 2 : /angle/.test(k) ? 90 : 1; }
    }
    const rec = { type: 'pattern', kind: s.kind, seeds, where, id, exprs };
    if (s.kind === 'linear') {
      const dir = (n, sp, ang, along, suffix) => {
        const c = count(n, `count${suffix}`);
        if (c == null) return null;
        if (c > 1 && !(Number.isFinite(sp) && sp !== 0)) { this.bad(`${where}: "spacing${suffix}" (distance between copies) is needed with "count${suffix}" > 1.`); return null; }
        const line = along != null ? this.shape(along, `${where}.along${suffix}`, ['line']) : null;
        if (along != null && !line) return null;
        if (ang != null && !Number.isFinite(ang)) { this.bad(`${where}: "angle${suffix}" in degrees.`); return null; }
        return { count: c, spacing: sp ?? 20, angle: ang ?? (suffix ? 90 : 0), line, reverse: false };
      };
      rec.d1 = dir(s.count, s.spacing, s.angle, s.along, '');
      rec.d2 = dir(s.count2, s.spacing2, s.angle2, s.along2, '2');
      if (!rec.d1 || !rec.d2) return;
      if (rec.d1.count * rec.d2.count - 1 > PATTERN_MAX_COPIES) { this.bad(`${where}: at most ${PATTERN_MAX_COPIES} copies.`); return; }
    } else if (s.kind === 'circular') {
      rec.center = this.point(s.center, `${where}.center`);
      rec.count = count(s.count, 'count', 2);
      if (s.total_angle != null && !(Number.isFinite(s.total_angle) && s.total_angle !== 0)) { this.bad(`${where}: "total_angle" in degrees (default 360: copies all round).`); return; }
      rec.angle = s.total_angle ?? 360;
      if (rec.center == null || rec.count == null) return;
      this.nodes[this.find(rec.center)].uses.add('ref');
    } else {
      rec.origin = this.point(s.origin, `${where}.origin`);
      if (!Array.isArray(s.targets) || !s.targets.length) { this.bad(`${where}: "targets": the points the copies go to.`); return; }
      rec.targets = s.targets.map((t, k) => this.point(t, `${where}.targets[${k}]`));
      if (rec.origin == null || rec.targets.some(t => t == null)) return;
      for (const n of [rec.origin, ...rec.targets]) this.nodes[this.find(n)].uses.add('ref');
    }
    if (!seeds.length) return;
    (this.patterns ??= []).push(rec);
  }

  /** Every node a shape uses (ends, centre, anchors). */
  shapeNodes(rec) {
    if (rec.type === 'line') return [rec.a, rec.b];
    if (rec.type === 'circle') return [rec.center];
    if (rec.type === 'arc') return [rec.center, rec.a, rec.b];
    if (rec.type === 'curve') return [rec.a, rec.b];
    if (rec.type === 'point') return [rec.node];
    return [];
  }

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
    // A curve's handle ("curve.c1" / "curve.c2"): for "symmetric" and "fix".
    const H = (k) => {
      const m = typeof c[k] === 'string' && /^(.+)\.(c1|c2)$/.exec(c[k]);
      const sh = m && this.shapeById.get(m[1]);
      return sh && sh.type === 'curve' ? { shape: sh, which: m[2] } : null;
    };
    const PH = (k) => H(k) ?? P(k);
    const S = (k, kinds) => this.shape(c[k], `${where}.${k}`, kinds);
    const ok = (...xs) => xs.every(x => x != null);
    // Dimensions: a number, or a formula ("W / 2", see "variables"); a
    // reference dimension only measures (its value may be left out).
    const reference = !!c.reference;
    const dim = (opts = {}) => {
      if (typeof c.value === 'string' && c.value.trim()) { rec.expr = c.value.trim(); return 0; }
      if (c.value == null && reference) { rec.measure = true; return 0; }
      return this.value(c.value, where, opts);
    };
    if (c.name != null) {
      if (typeof c.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(c.name)) { this.bad(`${where}: "name" is a dimension name like "W" or "hole_d" (letters, digits, _).`); return; }
      rec.name = c.name;
    }
    const lineOrPair = (k) => {
      const v = c[k];
      if (Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'string' || Array.isArray(x))) {
        const a = this.point(v[0], `${where}.${k}[0]`, { create: false }), b = this.point(v[1], `${where}.${k}[1]`, { create: false });
        return a != null && b != null ? { pair: [a, b] } : null;
      }
      const l = S(k, ['line']);
      return l ? { line: l } : null;
    };
    switch (c.type) {
      case 'horizontal': case 'vertical':
        if (c.line != null) { rec.line = S('line', ['line']); if (!ok(rec.line)) return; }
        else { rec.a = P('a'); rec.b = P('b'); if (!ok(rec.a, rec.b)) return; }
        break;
      case 'parallel': case 'perpendicular': case 'collinear':
        rec.l1 = S('a', ['line']); rec.l2 = S('b', ['line']); if (!ok(rec.l1, rec.l2)) return;
        break;
      case 'angle': {
        const a = lineOrPair('a'), b = lineOrPair('b');
        rec.signed = !!c.signed;
        rec.value = dim(rec.signed ? { min: -360, strict: false, max: 360 } : { min: 0, strict: false, max: 180 });
        if (!ok(a, b, rec.value)) return;
        if (a.line) rec.l1 = a.line; else rec.p1 = a.pair;
        if (b.line) rec.l2 = b.line; else rec.p2 = b.pair;
        break;
      }
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
        rec.s1 = S('a', ['line', 'round', 'curve']); rec.s2 = S('b', ['line', 'round', 'curve']);
        if (!ok(rec.s1, rec.s2)) return;
        const k1 = kindOf(rec.s1), k2 = kindOf(rec.s2);
        if (k1 === 'line' && k2 === 'line') { this.bad(`${where}: "tangent" needs a circle, arc or curve.`); return; }
        if (k1 === 'curve' && k2 === 'curve') { this.bad(`${where}: two curves meeting without a kink: use "smooth" at the point where they meet.`); return; }
        if (c.at != null && c.at !== 'start' && c.at !== 'end') { this.bad(`${where}: "at" is "start" or "end" of the curve.`); return; }
        rec.at = c.at ?? null;
        rec.internal = !!c.internal;
        break;
      }
      case 'smooth':
        rec.p = P('point'); if (!ok(rec.p)) return;
        break;
      case 'coincident':
        rec.a = P('a'); rec.b = P('b'); if (!ok(rec.a, rec.b)) return;
        this.union(rec.a, rec.b);
        return;                          // the two become one point: nothing to solve
      case 'midpoint':
        rec.p = P('point'); rec.line = S('line', ['line']); if (!ok(rec.p, rec.line)) return;
        break;
      case 'on':
        rec.p = P('point'); rec.s = S('shape', ['line', 'round', 'curve']); if (!ok(rec.p, rec.s)) return;
        break;
      case 'symmetric':
        rec.a = PH('a'); rec.b = PH('b'); rec.axis = S('axis', ['line']); if (!ok(rec.a, rec.b, rec.axis)) return;
        break;
      case 'fix':
        if (c.shape != null) {
          rec.s = S('shape', ['round']);
          if (!ok(rec.s)) return;
          if (!['r', 'start_angle', 'end_angle'].includes(c.param) || (rec.s.type === 'circle' && c.param !== 'r')) { this.bad(`${where}: with "shape", "param" is "r" (or, for an arc, "start_angle" / "end_angle"): that value is held as it is.`); return; }
          rec.type = 'fixParam'; rec.param = { r: 'r', start_angle: 'a0', end_angle: 'a1' }[c.param];
          break;
        }
        rec.p = PH('point'); if (!ok(rec.p)) return;
        break;
      case 'distance': {
        if (c.axis != null && c.axis !== 'x' && c.axis !== 'y') { this.bad(`${where}: "axis" is "x" (horizontal distance) or "y" (vertical distance).`); return; }
        rec.axis = c.axis ?? null;
        const isShape = (k) => typeof c[k] === 'string' && this.shapeById.has(c[k]) && !this.names.has(c[k]);
        const isRound = (k) => isShape(k) && kindOf(this.shapeById.get(c[k])) === 'round';
        if (isRound('a') && isRound('b')) {
          if (c.mode != null && c.mode !== 'gap' && c.mode !== 'radial') { this.bad(`${where}: "mode" is "gap" (between the circles, default) or "radial" (radius of a minus radius of b).`); return; }
          rec.mode = c.mode ?? 'gap';
          rec.value = dim({ min: 0, strict: rec.mode === 'radial' });
          rec.s1 = S('a', ['round']); rec.s2 = S('b', ['round']);
          if (rec.axis) { this.bad(`${where}: "axis" only applies between two points.`); return; }
          if (!ok(rec.s1, rec.s2, rec.value)) return;
          rec.type = 'roundDistance';
          break;
        }
        rec.value = dim();
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
        rec.line = S('line', ['line']); rec.value = dim(); if (!ok(rec.line, rec.value)) return;
        break;
      case 'radius': case 'diameter':
        rec.s = S('shape', ['round']); rec.value = dim(); if (!ok(rec.s, rec.value)) return;
        break;
      case 'offset': {
        const pairs = c.pairs ?? (c.a != null || c.b != null ? [[c.a, c.b]] : null);
        if (!Array.isArray(pairs) || !pairs.length) { this.bad(`${where}: { "a": source, "b": its offset copy, "value" } or { "pairs": [[source, copy], ...], "value" }.`); return; }
        rec.pairs = [];
        for (const [k, pr] of pairs.entries()) {
          if (!Array.isArray(pr) || pr.length !== 2) { this.bad(`${where}.pairs[${k}]: [source id, offset copy id].`); return; }
          const a = this.shape(pr[0], `${where}.pairs[${k}][0]`, ['line', 'round']), b = this.shape(pr[1], `${where}.pairs[${k}][1]`, ['line', 'round']);
          if (!a || !b) return;
          if (kindOf(a) !== kindOf(b)) { this.bad(`${where}.pairs[${k}]: a line offsets to a line, a circle or arc to a circle or arc.`); return; }
          rec.pairs.push([a, b]);
        }
        rec.value = c.value == null && !reference ? null : dim();
        if (c.value != null && rec.value == null) return;
        break;
      }
      default:
        this.bad(`${where}: unknown type ${JSON.stringify(c.type)}. Use one of ${CONSTRAINT_TYPES.join(', ')}.`);
        return;
    }
    if (reference) {
      if (!DRIVABLE.has(rec.type)) { this.bad(`${where}: "reference" applies to dimensions and "equal" (shown, not enforced).`); return; }
      rec.reference = true;
    }
    if (rec.name && !('value' in rec)) { this.bad(`${where}: "name" applies to dimensions.`); return; }
    if (rec.expr && rec.reference) { this.bad(`${where}: a reference dimension measures; it can't have a formula.`); return; }
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
      else if (s.type === 'curve') { use(s.a, 'end'); use(s.b, 'end'); }
    }
    for (const c of this.cons) {
      for (const k of ['a', 'b', 'p']) if (typeof c[k] === 'number') use(c[k], c.type === 'smooth' ? 'joint' : 'ref');
      for (const pr of [c.p1, c.p2]) if (pr) pr.forEach(n => use(n, 'ref'));
    }
    for (const s of this.shapes) {
      if ((s.type === 'line' || s.type === 'curve') && R(s.a) === R(s.b)) this.bad(`${s.where}: both ends are the same point.`);
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
      else if (s.type === 'curve') {
        e = new Bezier(ptOf(s.a), new Point(s.h1[0], s.h1[1]), new Point(s.h2[0], s.h2[1]), ptOf(s.b));
        owned.add(R(s.a)); owned.add(R(s.b));
      }
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
    this.ptOf = ptOf;
    for (const c of this.cons) {
      const made = this.native(c, ptOf);
      for (const n of made) {
        if (c.reference) n.driven = true;
        if (isDimension(n)) {                    // a name and a formula belong to the dimension itself
          if (c.name) n.name = c.name;
          if (c.expr) n.expr = c.expr;
        }
        sketch.constraints.push(n);
        this.byConstraintId.set(n.id, c);
      }
    }
    // Mirrored curves: their handles mirror the seed's too.
    for (const s of this.shapes) {
      if (!s.mirrorOf) continue;
      const seed = s.mirrorOf.seed.entity, copy = s.entity, ax = s.mirrorOf.axis.entity;
      for (const k of ['c1', 'c2']) sketch.constraints.push(new SymmetricConstraint(seed[k].id, copy[k].id, { a: ax.p1.id, b: ax.p2.id }, 'p1'));
    }
    this.applyEquations(project);
    if (this.problems.length) return project;
    if (this.display) project.display = { ...project.display, ...this.display };
    applyLayers(this, project);
    // Patterns, once the seeds have their layers (copies take them).
    for (const pt of this.patterns || []) {
      const lineRef = (l) => (l ? { a: l.entity.p1.id, b: l.entity.p2.id, id: l.entity.id } : null);
      const dir = (d) => ({ count: d.count, spacing: d.spacing, angle: d.angle, line: lineRef(d.line), reverse: false });
      const params = pt.kind === 'linear' ? { d1: dir(pt.d1), d2: dir(pt.d2) }
        : pt.kind === 'circular' ? { center: { id: ptOf(pt.center).id }, count: pt.count, angle: pt.angle, equal: true, reverse: false }
          : { origin: { id: ptOf(pt.origin).id }, targets: pt.targets.map(t => ({ key: ptOf(t).id, id: ptOf(t).id })) };
      if (Object.keys(pt.exprs).length) params.exprs = pt.exprs;     // stay live in the editor's Equations
      const k = new PatternConstraint(pt.kind, cleanPatternParams(pt.kind, params), pt.seeds.map(r => r.entity.id));
      syncPattern(sketch, k);
      sketch.constraints.push(k);
      this.byConstraintId.set(k.id, { where: pt.where });
    }
    return project;
  }

  /** The native constraint(s) for one record. */
  native(c, ptOf) {
    const id = (n) => ptOf(n).id;
    const pobj = (x) => (typeof x === 'number' ? ptOf(x) : x.shape.entity[x.which]);   // a node, or a curve handle
    const pid = (x) => pobj(x).id;
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
        const pairRef = (pr) => ({ a: id(pr[0]), b: id(pr[1]) });
        const l1 = c.l1 ? lref(c.l1) : pairRef(c.p1);
        let l2 = c.l2 ? lref(c.l2) : pairRef(c.p2);
        if (c.signed) {
          let v = c.value % 360; if (v > 180) v -= 360; if (v <= -180) v += 360;
          return [new DirectedAngleConstraint(l1, l2, v * DEG)];
        }
        const value = c.value * DEG;
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
        const curve = kindOf(c.s1) === 'curve' ? c.s1 : kindOf(c.s2) === 'curve' ? c.s2 : null;
        if (curve) {
          const other = curve === c.s1 ? c.s2 : c.s1, e = curve.entity;
          let at = c.at;
          if (!at) {
            const R = (n) => this.find(n), shared = new Set(this.shapeNodes(other).map(R));
            if (shared.has(R(curve.a))) at = 'start';
            else if (shared.has(R(curve.b))) at = 'end';
            else {
              const d = (p) => (other.type === 'line' ? distToLine(p, other.entity) : Math.abs(Math.hypot(p.x - other.entity.center.x, p.y - other.entity.center.y) - other.entity.r));
              at = d(e.p1) <= d(e.p2) ? 'start' : 'end';
            }
          }
          const [anchor, handle] = at === 'start' ? [e.p1, e.c1] : [e.p2, e.c2];
          const target = other.type === 'line' ? { line: lref(other) } : { circle: other.entity.id, centerId: other.entity.center.id };
          return [new CurveTangentConstraint(anchor.id, handle.id, target)];
        }
        const [l, o] = kindOf(c.s1) === 'line' ? [c.s1, c.s2] : kindOf(c.s2) === 'line' ? [c.s2, c.s1] : [null, null];
        if (l) return [new TangentLineCircleConstraint(lref(l), round(o).id, round(o).center.id)];
        const a = round(c.s1), b = round(c.s2);
        return [new TangentCircleCircleConstraint(a.id, a.center.id, b.id, b.center.id, c.internal)];
      }
      case 'midpoint': return [new MidpointConstraint(id(c.p), lref(c.line))];
      case 'on': {
        const e = c.s.entity;
        if (kindOf(c.s) === 'curve') return [new PointOnCurveConstraint(id(c.p), e.id, [e.p1.id, e.c1.id, e.c2.id, e.p2.id])];
        return [kindOf(c.s) === 'line' ? new PointOnLineConstraint(id(c.p), lref(c.s))
          : new PointOnCircleConstraint(id(c.p), round(c.s).id, round(c.s).center.id)];
      }
      case 'smooth': {
        const p = ptOf(c.p);
        const ends = [];
        for (const s of this.shapes) {
          if (s.type !== 'curve' || !s.entity) continue;
          if (s.entity.p1 === p) ends.push(s.entity.c1);
          if (s.entity.p2 === p) ends.push(s.entity.c2);
        }
        if (ends.length !== 2) { this.bad(`${c.where}: "smooth" needs exactly two curves meeting at that point (found ${ends.length}). For a curve meeting a line or circle, use "tangent".`); return []; }
        return [new SmoothConstraint(p.id, ends[0].id, ends[1].id)];
      }
      case 'fixParam': return [new ParamFixConstraint(c.s.entity.id, c.param, c.s.entity[c.param])];
      case 'roundDistance': return [new CurveDistanceConstraint(c.s1.entity.id, c.s2.entity.id, c.mode, c.value)];
      case 'offset': {
        const out = [], pairs = [];
        for (const [src, tgt] of c.pairs) {
          const a = src.entity, b = tgt.entity;
          if (kindOf(src) === 'line') {
            out.push(new OffsetConstraint(a.id, b.id, 'line', { l1: { a: a.p1.id, b: a.p2.id }, l2: { a: b.p1.id, b: b.p2.id } }));
            const dx = a.p2.x - a.p1.x, dy = a.p2.y - a.p1.y, len = Math.hypot(dx, dy) || 1;
            const side = (dx * (b.p1.y - a.p1.y) - dy * (b.p1.x - a.p1.x)) / len < 0 ? -1 : 1;
            pairs.push({ kind: 'line', pointId: b.p1.id, l: { a: a.p1.id, b: a.p2.id }, sourceEntityId: a.id, targetEntityId: b.id, value: side * (c.value ?? 0) });
          } else {
            if (a.center !== b.center) out.push(new OffsetConstraint(a.id, b.id, 'circle', { p1: a.center.id, p2: b.center.id }));
            pairs.push({ kind: 'circle', c1: b.id, c2: a.id, value: (b.r - a.r < 0 ? -1 : 1) * (c.value ?? 0) });
          }
        }
        if (c.value != null) { const k = new OffsetDistanceConstraint(pairs, Math.abs(c.value)); k._offsetPairs = true; out.push(k); }
        return out;
      }
      case 'symmetric': return [new SymmetricConstraint(pid(c.a), pid(c.b), lref(c.axis), 'p1')];
      case 'fix': { const p = pobj(c.p); return [new FixConstraint(p.id, p.x, p.y)]; }
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

  /** Sliders for the variables that asked for one, in a column left of
   *  the drawing (they keep a constant size on screen). */
  placeSliders(project) {
    const want = this.variables.filter(v => v.slider);
    if (!want.length) return;
    let x0 = Infinity, y1 = -Infinity, y0 = Infinity, x1 = -Infinity;
    const walk = (e) => { if (e instanceof Point) { x0 = Math.min(x0, e.x); x1 = Math.max(x1, e.x); y0 = Math.min(y0, e.y); y1 = Math.max(y1, e.y); } for (const c of e.children()) walk(c); };
    project.active().entities.forEach(walk);
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 100; y0 = 0; y1 = 100; }
    const size = Math.max(x1 - x0, y1 - y0, 1);
    want.forEach((v, k) => {
      const pv = project.variables.find(x => x.name === v.name);
      const value = Number(v.expr);
      const top = niceCeil(Math.abs(value) * 2 || 10);
      const min = v.slider.min ?? (value >= 0 ? 0 : -top), max = v.slider.max ?? top;
      if (!(max > min)) { this.bad(`${v.where}: the slider's "max" must be above its "min".`); return; }
      pv.slider = { x: x0, y: y0 - size * (0.12 + 0.1 * k), min, max, step: v.slider.step ?? niceStep(max - min) };
    });
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
    // What the editor would show in red (it shows redundant rows nobody is
    // blamed for, like an offset's "same direction" row, as fine).
    if (r.state === 'over' || r.redundantIds?.size > 0) {
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
function niceStep(range) {
  const raw = Math.max(Math.abs(range) / 100, 1e-9), p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return Number(((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p).toPrecision(3));
}
function niceCeil(v) { const p = 10 ** Math.floor(Math.log10(v)), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
function distToLine(p, l) {
  const dx = l.p2.x - l.p1.x, dy = l.p2.y - l.p1.y, len = Math.hypot(dx, dy) || 1;
  return Math.abs(dx * (p.y - l.p1.y) - dy * (p.x - l.p1.x)) / len;
}
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

  // Variables (with their sliders) and what the editor shows.
  if (project.variables?.length) {
    spec.variables = {};
    for (const v of project.variables) {
      const num = /^\s*-?\d+(\.\d+)?(e-?\d+)?\s*$/i.test(v.expr) ? Number(v.expr) : v.expr;
      spec.variables[v.name] = v.slider ? { value: num, slider: { min: v.slider.min, max: v.slider.max, step: v.slider.step } } : num;
    }
  }
  if (project.display) {
    const keys = { grid: 'grid', snap: 'snap', dimensions: 'dimensions', relations: 'relations', dimNames: 'names' };
    const d = Object.fromEntries(Object.entries(keys).filter(([k]) => (k === 'dimNames' ? project.display[k] === true : project.display[k] === false)).map(([k, n]) => [n, !!project.display[k]]));   // only what differs from the defaults
    if (Object.keys(d).length) spec.display = d;
  }

  // Patterns: their copies are made again from the pattern, so they are left out.
  const copies = new Set();
  const patterns = sketch.constraints.filter(c => c.kind === 'pattern');
  for (const c of patterns) for (const inst of c.instances || []) for (const pr of inst.pairs) copies.add(pr[1]);

  const pointName = new Map();     // Point id → spec name
  const nameOf = (p) => {
    if (p.bezierOwner) {
      const owner = p.bezierOwner;
      if (copies.has(owner.id)) { unsupported.add('relations or links on pattern copies'); return null; }
      return `${owner.id}.${owner.c1 === p ? 'c1' : 'c2'}`;      // only "symmetric" and "fix" take these (checked in out)
    }
    if (copies.has(p.id)) { unsupported.add('relations or links on pattern copies'); return null; }
    if (!pointName.has(p.id)) {
      pointName.set(p.id, p.id);
      spec.points[p.id] = [r6(p.x), r6(p.y)];
    }
    return pointName.get(p.id);
  };
  const arcEnd = new Map();        // `${arcId}.${which}` → point it is tied to
  for (const c of sketch.constraints) {
    if (c.kind === 'arcEndpointCoincident') arcEnd.set(`${c.ref.arcId}.${c.ref.which}`, c.pointId);
  }
  const all = new Map();
  for (const e of sketch.entities) { all.set(e.id, e); for (const ch of e.children()) all.set(ch.id, ch); }
  const shapeIds = new Set();
  const xy = (p) => [r6(p.x), r6(p.y)];
  for (const e of sketch.entities) {
    if (copies.has(e.id)) continue;
    const base = { id: e.id, ...(e.construction ? { construction: true } : {}) };
    if (e instanceof Line) spec.shapes.push({ ...base, type: 'line', from: nameOf(e.p1), to: nameOf(e.p2) });
    else if (e instanceof Circle) spec.shapes.push({ ...base, type: 'circle', center: nameOf(e.center), r: r6(e.r) });
    else if (e instanceof Arc) {
      e.syncEnds();
      const end = (which, p) => {
        const tied = arcEnd.get(`${e.id}.${which}`);
        return tied && all.get(tied) ? nameOf(all.get(tied)) : xy(p);
      };
      spec.shapes.push({ ...base, type: 'arc', center: nameOf(e.center), from: end('start', e.start), to: end('end', e.end), ...(e.clockwise ? { clockwise: true } : {}) });
    } else if (e instanceof Bezier) {
      spec.shapes.push({ ...base, type: 'curve', from: nameOf(e.p1), to: nameOf(e.p2), c1: xy(e.c1), c2: xy(e.c2) });
    } else if (e instanceof Point) spec.shapes.push({ type: 'point', at: nameOf(e), ...(e.construction ? { construction: true } : {}) });
    else { unsupported.add(`${e.constructor.kind || 'unknown'} shapes`); continue; }
    shapeIds.add(e.id);
  }
  const shapeRef = (id) => (copies.has(id) ? (unsupported.add('relations or links on pattern copies'), null) : id);
  // A point refers to its spec name; an arc end to the arc's alias.
  const P = (id) => pointName.get(id) ?? (all.get(id) instanceof Point ? nameOf(all.get(id)) : null);
  const arcRefName = (ref) => {
    const tied = arcEnd.get(`${ref.arcId}.${ref.which}`);
    return tied ? P(tied) : `${ref.arcId}.${ref.which}`;
  };
  const lineOf = (l) => {
    for (const e of sketch.entities) {
      if (e instanceof Line && ((e.p1.id === l.a && e.p2.id === l.b) || (e.p1.id === l.b && e.p2.id === l.a))) return shapeRef(e.id);
    }
    return null;
  };
  const lineOrPair = (l) => lineOf(l) ?? (P(l.a) && P(l.b) ? [P(l.a), P(l.b)] : null);
  const roundOfCenter = (centerId) => sketch.entities.find(e => (e instanceof Circle || e instanceof Arc) && e.center.id === centerId)?.id ?? null;
  const curveOfHandle = (hid) => sketch.entities.find(e => e instanceof Bezier && (e.c1.id === hid || e.c2.id === hid));
  // Dimension value: its formula, else the number (in the user's terms).
  const val = (c, v) => (c.expr ? c.expr : r6(v));
  const handleRe = /^(.+)\.(c1|c2)$/;
  const isHandle = (v) => typeof v === 'string' && handleRe.test(v) && all.get(handleRe.exec(v)[1]) instanceof Bezier;
  const out = (o, c) => {
    if (!Object.values(o).every(v => v != null && !(Array.isArray(v) && v.some(x => x == null)))) { unsupported.add(`a ${o.type} constraint`); return; }
    if (o.type !== 'symmetric' && o.type !== 'fix' && Object.values(o).flat().some(isHandle)) { unsupported.add('relations on curve handles'); return; }
    if (c?.driven) o.reference = true;
    if (c?.name && 'value' in o && !/^D\d+$/.test(c.name)) o.name = c.name;
    else if (c?.name && 'value' in o && usedNames.has(c.name)) o.name = c.name;
    spec.constraints.push(o);
  };
  // Names formulas refer to (so an automatic D3 is kept when used).
  const usedNames = new Set();
  const noteNames = (src) => { for (const m of String(src || '').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) usedNames.add(m[0]); };
  for (const c of sketch.constraints) noteNames(c.expr);
  for (const v of project.variables || []) noteNames(v.expr);
  for (const c of patterns) for (const e of Object.values(c.params.exprs || {})) noteNames(e);

  const offsetsCovered = new Set();
  for (const c of sketch.constraints) {
    if (c.kind !== 'pattern' && copies.size && c.refs().some(id => copies.has(id))) { unsupported.add('relations or links on pattern copies'); continue; }
    switch (c.kind) {
      case 'arcEndpointCoincident': break;                // expressed through the arc's from / to
      case 'arcEndpointArcEndpointCoincident': out({ type: 'coincident', a: arcRefName(c.ref1), b: arcRefName(c.ref2) }); break;
      case 'coincident': out({ type: 'coincident', a: P(c.p1), b: P(c.p2) }); break;
      case 'horizontal': case 'vertical': out({ type: c.kind, line: c.lineId }); break;
      case 'pointRefHorizontal': case 'pointRefVertical':
        out({ type: c.kind === 'pointRefHorizontal' ? 'horizontal' : 'vertical', a: c.ref1.pointId ? P(c.ref1.pointId) : arcRefName(c.ref1), b: c.ref2.pointId ? P(c.ref2.pointId) : arcRefName(c.ref2) });
        break;
      case 'parallel': case 'perpendicular': case 'collinear': out({ type: c.kind, a: lineOf(c.l1), b: lineOf(c.l2) }); break;
      case 'angle': out({ type: 'angle', a: lineOrPair(c.l1), b: lineOrPair(c.l2), value: val(c, c.value / DEG) }, c); break;
      case 'directedAngle': out({ type: 'angle', signed: true, a: lineOrPair(c.l1), b: lineOrPair(c.l2), value: val(c, c.value / DEG) }, c); break;
      case 'equalLength': out({ type: 'equal', a: lineOf(c.l1), b: lineOf(c.l2) }, c); break;
      case 'equalRadius': out({ type: 'equal', a: c.c1, b: c.c2 }, c); break;
      case 'concentric': out({ type: 'concentric', a: roundOfCenter(c.p1), b: roundOfCenter(c.p2) }); break;
      case 'tangent':
        if ('l' in c) out({ type: 'tangent', a: lineOf(c.l), b: c.circleId });
        else out({ type: 'tangent', a: c.c1, b: c.c2, ...(c.internal ? { internal: true } : {}) });
        break;
      case 'curveTangent': {
        const cv = curveOfHandle(c.handleId);
        out({ type: 'tangent', a: cv?.id ?? null, b: c.line ? lineOf(c.line) : c.circleId, at: cv && cv.c1.id === c.handleId ? 'start' : 'end' });
        break;
      }
      case 'smooth': out({ type: 'smooth', point: P(c.anchorId) }); break;
      case 'pointOnCurve': out({ type: 'on', point: P(c.pointId), shape: c.curveId }); break;
      case 'midpoint': out({ type: 'midpoint', point: P(c.pointId), line: lineOf(c.l) }); break;
      case 'arcEndpointMidpoint': out({ type: 'midpoint', point: arcRefName(c.ref), line: lineOf(c.l) }); break;
      case 'pointOnLine': out({ type: 'on', point: P(c.pointId), shape: lineOf(c.l) }); break;
      case 'arcEndpointOnLine': out({ type: 'on', point: arcRefName(c.ref), shape: lineOf(c.l) }); break;
      case 'pointOnCircle': out({ type: 'on', point: P(c.pointId), shape: c.circleId }); break;
      case 'arcEndpointOnCircle': out({ type: 'on', point: arcRefName(c.ref), shape: c.circleId }); break;
      case 'symmetric': out({ type: 'symmetric', a: P(c.p1), b: P(c.p2), axis: lineOf(c.axis) }); break;
      case 'fix': out({ type: 'fix', point: P(c.pointId) }); break;
      case 'arcEndpointFix': out({ type: 'fix', point: arcRefName(c.ref) }); break;
      case 'paramFix': {
        const e = all.get(c.entityId), param = { r: 'r', a0: 'start_angle', a1: 'end_angle' }[c.key];
        if ((e instanceof Circle || e instanceof Arc) && param && (e instanceof Arc || param === 'r')) out({ type: 'fix', shape: e.id, param });
        else unsupported.add('held values on that kind of shape');
        break;
      }
      case 'distance': out({ type: 'distance', a: P(c.p1), b: P(c.p2), value: val(c, c.value), ...(c.axis ? { axis: c.axis } : {}) }, c); break;
      case 'pointLineDistance': out({ type: 'distance', a: P(c.pointId), b: lineOf(c.l), value: val(c, c.value) }, c); break;
      case 'radius': out(c.isDiameter ? { type: 'diameter', shape: c.circleId, value: val(c, c.value * 2) } : { type: 'radius', shape: c.circleId, value: val(c, c.value) }, c); break;
      case 'curveDistance': out({ type: 'distance', a: c.c1, b: c.c2, mode: c.mode, value: val(c, c.value) }, c); break;
      case 'offset': break;                                // with its distance, below
      case 'offsetDistance': {
        const pairs = c.pairs.map(p => (p.kind === 'line'
          ? [lineOf(p.l), p.targetEntityId ?? sketch.entities.find(e => e instanceof Line && e.p1.id === p.pointId)?.id ?? null]
          : [p.c2, p.c1]));
        for (const pr of pairs) offsetsCovered.add(pr.join('>'));
        out({ type: 'offset', pairs, value: val(c, c.value) }, c);
        break;
      }
      case 'pattern': {
        const pr = c.params, ex = pr.exprs || {};
        const f = (path, v) => (ex[path] ?? v);
        const ref = (r) => (r?.id ? P(r.id) : r ? [r6(r.x), r6(r.y)] : null);
        const o = { type: 'pattern', id: c.id, kind: c.type, of: c.seeds.slice() };
        if (c.type === 'linear') {
          for (const [d, sfx] of [[pr.d1, ''], [pr.d2, '2']]) {
            const k = sfx ? 'd2' : 'd1';
            o[`count${sfx}`] = f(`${k}.count`, d.count);
            o[`spacing${sfx}`] = f(`${k}.spacing`, d.reverse ? -d.spacing : d.spacing);
            if (d.line?.id) o[`along${sfx}`] = d.line.id; else o[`angle${sfx}`] = f(`${k}.angle`, d.angle);
            if (d.reverse && ex[`${k}.spacing`]) unsupported.add('reversed patterns with formulas');
          }
        } else if (c.type === 'circular') {
          Object.assign(o, { center: ref(pr.center), count: f('count', pr.count), total_angle: f('angle', pr.reverse ? -pr.angle : pr.angle) });
          if (pr.equal === false) unsupported.add('circular patterns with a set step');
        } else Object.assign(o, { origin: ref(pr.origin), targets: (pr.targets || []).map(ref) });
        if (c.skipped?.length) unsupported.add('patterns with skipped copies');
        if (o.of.some(id => !shapeIds.has(id)) || Object.values(o).some(v => v == null)) { unsupported.add('a pattern'); break; }
        spec.shapes.push(o);
        break;
      }
      default: unsupported.add(`${c.kind} constraints`);
    }
  }
  // Offset relations without a distance.
  for (const c of sketch.constraints) {
    if (c.kind !== 'offset') continue;
    const key = `${c.sourceEntityId}>${c.targetEntityId}`;
    if (!offsetsCovered.has(key)) out({ type: 'offset', pairs: [[c.sourceEntityId, c.targetEntityId]] });
  }
  // A distance on a line's own ends reads better as a length.
  for (const k of spec.constraints) {
    if (k.type === 'distance' && !k.axis && !k.mode && typeof k.a === 'string' && typeof k.b === 'string') {
      const l = sketch.entities.find(e => e instanceof Line && !copies.has(e.id) && [P(e.p1.id), P(e.p2.id)].sort().join() === [k.a, k.b].sort().join());
      if (l && shapeIds.has(l.id)) { k.type = 'length'; k.line = l.id; delete k.a; delete k.b; }
    }
  }
  presentationToSpec(project, sketch, spec, unsupported, P, copies);
  // Patterns go after the shapes they repeat (they are listed with them).
  spec.shapes.sort((a, b) => (a.type === 'pattern') - (b.type === 'pattern'));
  return { spec, lossless: unsupported.size === 0, unsupported: [...unsupported] };
}

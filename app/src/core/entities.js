import { EPS, TAU, angleOnDirectedArc, clamp, dist, drawDirectedArcPath } from './math.js';
import { bezierAt, bezierNearest, bezierSamples, polygonLength } from './bezier.js';

/* =============== 2. ENTITIES ================================== */
let _idSeq = 1;
export const newId = (prefix='e') => prefix + (_idSeq++);
/** Make sure ids generated from now on are greater than n. */
export function ensureIdAbove(n) { if (n >= _idSeq) _idSeq = n + 1; }

export class Entity {
  constructor() {
    this.id = newId();
    this.sketchId = null;         // owning sketch (set by Sketch.addEntity)
    this.layerId = null;          // display layer (see core/style.js)
    this.style = null;            // per-entity style overrides, or null
    this.construction = false;
    this.fixed = false;
    this.locked = false;          // held constant by the solver (transient; layers never set it, see Project.syncLocks)
    this.status = 'under';        // 'under' | 'fully' | 'over'
    this.selected = false;
    this.hover = false;
  }
  paramKeys() { return []; }
  getParam(k) { return this[k]; }
  setParam(k, v) { this[k] = v; }
  children() { return []; }
  toJSON() {
    const o = { type: this.constructor.kind, id: this.id,
                construction: this.construction, fixed: this.fixed };
    for (const k of this.paramKeys()) o[k] = this[k];
    return this._withMeta(o);
  }
  /** Adds layer / style fields when set, so plain geometry stays compact. */
  _withMeta(o) {
    if (this.layerId) o.layerId = this.layerId;
    if (this.style) o.style = { ...this.style };
    return o;
  }
}

/** Applies a resolved draw style's stroke settings to ctx. */
function applyStroke(ctx, style) {
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  if (style.dash && style.dash.length) ctx.setLineDash(style.dash);
  else if (style.dashed) ctx.setLineDash([6, 4]);
}

export class Point extends Entity {
  static kind = 'point';
  constructor(x = 0, y = 0) { super(); this.x = x; this.y = y; }
  paramKeys() { return ['x','y']; }
  hit(world, view) { return dist(this, world) * view.zoom < 7; }
  draw(ctx, view, style) {
    const p = view.worldToScreen(this);
    if (this.bezierOwner) {                      // a curve's handle: square + stem
      if (!bezierHandlesShown(this.bezierOwner)) return;
      const a = view.worldToScreen(this.bezierOwner.anchorOf(this));
      ctx.save();
      ctx.strokeStyle = style.color; ctx.fillStyle = style.color;
      ctx.globalAlpha *= 0.75; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.globalAlpha /= 0.75;
      const h = this.selected ? 4.5 : 3.5;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(p.x - h, p.y - h, 2 * h, 2 * h);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(p.x - h, p.y - h, 2 * h, 2 * h);
      if (this.selected) { ctx.fillStyle = style.color; ctx.fillRect(p.x - h + 2, p.y - h + 2, 2 * h - 4, 2 * h - 4); }
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.selected ? 4.5 : 3, 0, TAU);
    ctx.fill();
    if (this.fixed) {
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }
}

export class Line extends Entity {
  static kind = 'line';
  constructor(p1, p2) { super(); this.p1 = p1; this.p2 = p2; }
  children() { return [this.p1, this.p2]; }
  hit(world, view) {
    const a = this.p1, b = this.p2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx*dx + dy*dy;
    if (L2 < EPS) return dist(world, a) * view.zoom < 6;
    let t = ((world.x - a.x)*dx + (world.y - a.y)*dy) / L2;
    t = clamp(t, 0, 1);
    const px = a.x + t*dx, py = a.y + t*dy;
    return Math.hypot(world.x - px, world.y - py) * view.zoom < 6;
  }
  draw(ctx, view, style) {
    const a = view.worldToScreen(this.p1);
    const b = view.worldToScreen(this.p2);
    ctx.save();
    applyStroke(ctx, style);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
  toJSON() {
    return this._withMeta({ type: 'line', id: this.id,
             construction: this.construction, fixed: this.fixed,
             p1: this.p1.toJSON(), p2: this.p2.toJSON() });
  }
}

export class Circle extends Entity {
  static kind = 'circle';
  constructor(center, r) { super(); this.center = center; this.r = r; }
  paramKeys() { return ['r']; }
  children() { return [this.center]; }
  hit(world, view) {
    const d = dist(this.center, world);
    return Math.abs(d - this.r) * view.zoom < 6;
  }
  draw(ctx, view, style) {
    const c = view.worldToScreen(this.center);
    ctx.save();
    applyStroke(ctx, style);
    ctx.beginPath();
    ctx.arc(c.x, c.y, this.r * view.zoom, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  toJSON() {
    return this._withMeta({ type: 'circle', id: this.id,
             construction: this.construction, fixed: this.fixed,
             center: this.center.toJSON(), r: this.r });
  }
}

export class Arc extends Entity {
  static kind = 'arc';
  constructor(center, r, a0, a1) {
    super();
    this.center = center; this.r = r; this.a0 = a0; this.a1 = a1;
    this.clockwise = false;
    this.start = new Point(center.x + r*Math.cos(a0), center.y + r*Math.sin(a0));
    this.end   = new Point(center.x + r*Math.cos(a1), center.y + r*Math.sin(a1));
    this.start.arcOwner = this; this.start.arcEndpoint = 'start';
    this.end.arcOwner = this;   this.end.arcEndpoint = 'end';
  }
  paramKeys() { return ['r', 'a0', 'a1']; }
  children() { return [this.center, this.start, this.end]; }
  syncEnds() {
    this.start.x = this.center.x + this.r*Math.cos(this.a0);
    this.start.y = this.center.y + this.r*Math.sin(this.a0);
    this.end.x   = this.center.x + this.r*Math.cos(this.a1);
    this.end.y   = this.center.y + this.r*Math.sin(this.a1);
  }
  hit(world, view) {
    this.syncEnds();
    const dx = world.x - this.center.x, dy = world.y - this.center.y;
    const d = Math.hypot(dx, dy);
    if (Math.abs(d - this.r) * view.zoom > 6) return false;
    return angleOnDirectedArc(Math.atan2(dy, dx), this.a0, this.a1, this.clockwise);
  }
  draw(ctx, view, style) {
    this.syncEnds();
    ctx.save();
    applyStroke(ctx, style);
    ctx.beginPath();
    drawDirectedArcPath(ctx, view, this.center, this.r, this.a0, this.a1, this.clockwise);
    ctx.stroke();
    ctx.restore();
  }
  toJSON() {
    return this._withMeta({ type: 'arc', id: this.id,
             construction: this.construction, fixed: this.fixed,
             center: this.center.toJSON(),
             r: this.r, a0: this.a0, a1: this.a1, clockwise: !!this.clockwise });
  }
}

/**
 * Cubic Bézier curve: anchors p1, p2 (shared with other shapes like any
 * end point) and handles c1 (leaves p1), c2 (arrives at p2). All four are
 * ordinary points for the solver, so relations and dimensions work on
 * handles too. Handles show (and can be picked) only while the curve or
 * one of its points is selected: see bezierHandlesShown().
 */
export class Bezier extends Entity {
  static kind = 'bezier';
  constructor(p1, c1, c2, p2) {
    super();
    this.p1 = p1; this.c1 = c1; this.c2 = c2; this.p2 = p2;
    c1.bezierOwner = this; c1.handleAnchor = 'p1';
    c2.bezierOwner = this; c2.handleAnchor = 'p2';
  }
  children() { return [this.p1, this.c1, this.c2, this.p2]; }
  /** Control points [P0, P1, P2, P3] (live objects). */
  ctrl() { return [this.p1, this.c1, this.c2, this.p2]; }
  at(t) { return bezierAt(this.ctrl(), t); }
  /** Anchor a handle belongs to. */
  anchorOf(h) { return h === this.c1 ? this.p1 : h === this.c2 ? this.p2 : null; }
  /** Handle at an anchor ('p1' / 'p2' or the point). */
  handleAt(a) { return a === this.p1 || a === 'p1' ? this.c1 : a === this.p2 || a === 'p2' ? this.c2 : null; }
  hit(world, view) {
    const P = this.ctrl();
    const tolW = 6 / view.zoom;
    // quick reject on the control polygon's box (the curve lies inside it)
    const xs = P.map(p => p.x), ys = P.map(p => p.y);
    if (world.x < Math.min(...xs) - tolW || world.x > Math.max(...xs) + tolW ||
        world.y < Math.min(...ys) - tolW || world.y > Math.max(...ys) + tolW) return false;
    return bezierNearest(P, world, 24).d * view.zoom < 6;
  }
  draw(ctx, view, style) {
    const [a, b, c, d] = this.ctrl().map(p => view.worldToScreen(p));
    ctx.save();
    applyStroke(ctx, style);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(b.x, b.y, c.x, c.y, d.x, d.y);
    ctx.stroke();
    ctx.restore();
  }
  /** Sampled points (regions, export to polylines). */
  points(n) { return bezierSamples(this.ctrl(), n || Math.max(16, Math.min(128, Math.ceil(polygonLength(this.ctrl()) / 2)))); }
  toJSON() {
    return this._withMeta({ type: 'bezier', id: this.id,
             construction: this.construction, fixed: this.fixed,
             p1: this.p1.toJSON(), c1: this.c1.toJSON(), c2: this.c2.toJSON(), p2: this.p2.toJSON() });
  }
}

/** Works out which curves show their handles: a selected curve (or one
 *  with a selected point), and its neighbours at the ends concerned, so
 *  both handles of a joint show while you shape it. Called before drawing. */
export function refreshHandleVisibility(entities) {
  const curves = entities.filter(e => e instanceof Bezier);
  for (const b of curves) b.showHandles = false;
  for (const b of curves) {
    const at = new Set();
    if (b.selected || b.p1.selected || b.c1.selected) at.add(b.p1);
    if (b.selected || b.p2.selected || b.c2.selected) at.add(b.p2);
    if (!at.size && !b.c1.selected && !b.c2.selected) continue;
    b.showHandles = true;
    for (const o of curves) if (o !== b && (at.has(o.p1) || at.has(o.p2))) o.showHandles = true;
  }
}

/** Whether a curve's handles are shown and pickable: the curve, or one of
 *  its points, is selected, or it joins one that is (see above). */
export function bezierHandlesShown(b) {
  return !!(b && (b.showHandles || b.selected || b.p1.selected || b.p2.selected || b.c1.selected || b.c2.selected));
}
/** A handle point that is hidden right now (not drawn, not picked, not snapped to). */
export const isHiddenHandle = (p) => !!(p && p.bezierOwner && !bezierHandlesShown(p.bezierOwner));

import { EPS, TAU, angleOnDirectedArc, clamp, dist, drawDirectedArcPath } from './math.js';

/* =============== 2. ENTITIES ================================== */
let _idSeq = 1;
export const newId = (prefix='e') => prefix + (_idSeq++);
/** Make sure ids generated from now on are greater than n. */
export function ensureIdAbove(n) { if (n >= _idSeq) _idSeq = n + 1; }

export class Entity {
  constructor() {
    this.id = newId();
    this.layerId = null;
    this.construction = false;
    this.fixed = false;
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
    return o;
  }
}

export class Point extends Entity {
  static kind = 'point';
  constructor(x = 0, y = 0) { super(); this.x = x; this.y = y; }
  paramKeys() { return ['x','y']; }
  hit(world, view) { return dist(this, world) * view.zoom < 7; }
  draw(ctx, view, style) {
    const p = view.worldToScreen(this);
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
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
  toJSON() {
    return { type: 'line', id: this.id,
             construction: this.construction, fixed: this.fixed,
             p1: this.p1.toJSON(), p2: this.p2.toJSON() };
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
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, this.r * view.zoom, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  toJSON() {
    return { type: 'circle', id: this.id,
             construction: this.construction, fixed: this.fixed,
             center: this.center.toJSON(), r: this.r };
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
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    drawDirectedArcPath(ctx, view, this.center, this.r, this.a0, this.a1, this.clockwise);
    ctx.stroke();
    ctx.restore();
  }
  toJSON() {
    return { type: 'arc', id: this.id,
             construction: this.construction, fixed: this.fixed,
             center: this.center.toJSON(),
             r: this.r, a0: this.a0, a1: this.a1, clockwise: !!this.clockwise };
  }
}

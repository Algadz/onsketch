// Small builders shared by the unit tests.
import { Point, Line, Circle, Arc } from '../../app/src/core/entities.js';
import { Sketch } from '../../app/src/core/model.js';
import { Solver } from '../../app/src/core/solver.js';

export const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
export const ref = (line) => ({ a: line.p1.id, b: line.p2.id });

export function sketch() { return new Sketch('Test'); }
export function line(s, x1, y1, x2, y2) {
  const l = new Line(new Point(x1, y1), new Point(x2, y2)); s.addEntity(l); return l;
}
export function circle(s, x, y, r) { const c = new Circle(new Point(x, y), r); s.addEntity(c); return c; }
export function arc(s, x, y, r, a0, a1) { const a = new Arc(new Point(x, y), r, a0, a1); s.addEntity(a); return a; }
export function point(s, x, y) { const p = new Point(x, y); s.addEntity(p); return p; }

export function solve(s, options = {}) {
  return new Solver().solve(s, [s], [], { diagnostics: true, ...options });
}

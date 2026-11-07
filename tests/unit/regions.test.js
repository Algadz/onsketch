import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point, Line, Circle, Arc } from '../../app/src/core/entities.js';
import { findClosedProfiles, findFaceAt, boundedFaces, regionContains, interiorPoint } from '../../app/src/core/regions.js';

function rect(x, y, w, h, shared = true) {
  const pts = [new Point(x, y), new Point(x + w, y), new Point(x + w, y + h), new Point(x, y + h)];
  const q = (p) => shared ? p : new Point(p.x + 1e-9, p.y - 1e-9);   // near-coincident copies
  return [0, 1, 2, 3].map(i => new Line(i ? q(pts[i]) : pts[i], pts[(i + 1) % 4]));
}

test('a rectangle with shared corners is one loop', () => {
  const { loops, circles } = findClosedProfiles(rect(0, 0, 10, 5));
  assert.equal(loops.length, 1); assert.equal(circles.length, 0);
  assert.equal(loops[0].length, 4);
});

test('corners that only coincide numerically still close', () => {
  assert.equal(findClosedProfiles(rect(0, 0, 10, 5, false)).loops.length, 1);
});

test('open chains and branching networks are not filled', () => {
  const r = rect(0, 0, 10, 5);
  assert.equal(findClosedProfiles(r.slice(0, 3)).loops.length, 0);
  const spur = new Line(r[0].p1, new Point(-5, -5));
  assert.equal(findClosedProfiles([...r, spur]).loops.length, 0);
});

test('a slot made of two lines and two arcs is one loop', () => {
  const top = new Line(new Point(0, 2), new Point(10, 2));
  const bot = new Line(new Point(10, -2), new Point(0, -2));
  const right = new Arc(new Point(10, 0), 2, -Math.PI / 2, Math.PI / 2);
  const left = new Arc(new Point(0, 0), 2, Math.PI / 2, 1.5 * Math.PI);
  const { loops } = findClosedProfiles([top, right, bot, left]);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].length > 10);
});

test('circles are returned for even-odd filling', () => {
  const { loops, circles } = findClosedProfiles([...rect(0, 0, 10, 10), new Circle(new Point(5, 5), 2)]);
  assert.equal(loops.length, 1); assert.equal(circles.length, 1);
});

const area = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p.x * q.y - q.x * p.y; }, 0) / 2);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('fill picks the smallest enclosing face, with separate inner shapes as holes', () => {
  const outer = rect(0, 0, 10, 10);
  const inner = rect(2, 2, 2, 2);
  const hole = new Circle(new Point(7, 7), 1);
  const ents = [...outer, ...inner, hole];
  const f = findFaceAt(ents, { x: 5, y: 1 });
  assert.ok(near(f.area, 100, 1e-6));
  assert.equal(f.holes.length, 2);
  assert.ok(!regionContains(f, { x: 3, y: 3 }) && !regionContains(f, { x: 7, y: 7 }) && regionContains(f, { x: 5, y: 1 }));
  const g = findFaceAt(ents, { x: 3, y: 3 });
  assert.ok(near(g.area, 4)); assert.equal(g.holes.length, 0);
  assert.equal(findFaceAt(ents, { x: 20, y: 20 }), null);
});

test('two rectangles sharing a whole side (shared corner points, duplicate edge)', () => {
  const a = rect(0, 0, 10, 5);
  // B reuses A's right-hand corners, so its left side duplicates A's right side.
  const tr = a[1].p2, br = a[0].p2;
  const b = [new Line(br, new Point(20, 0)), new Line(new Point(20, 0), new Point(20, 5)),
    new Line(new Point(20, 5), tr), new Line(tr, br)];
  const ents = [...a, ...b];
  const left = findFaceAt(ents, { x: 5, y: 2 }), right = findFaceAt(ents, { x: 15, y: 2 });
  assert.ok(near(left.area, 50) && near(right.area, 50));
  assert.ok(regionContains(left, { x: 5, y: 2 }) && !regionContains(left, { x: 15, y: 2 }));
  assert.equal(boundedFaces(ents).length, 2);
});

test('a shape whose side lies along part of another shape (T-junctions, no shared points)', () => {
  const big = rect(0, 0, 10, 10);
  const small = rect(10, 3, 4, 4);   // left side sits on big's right side, between y=3 and y=7
  const ents = [...big, ...small];
  const s = findFaceAt(ents, { x: 12, y: 5 });
  assert.ok(near(s.area, 16), `small area ${s.area}`);
  const b = findFaceAt(ents, { x: 5, y: 5 });
  assert.ok(near(b.area, 100), `big area ${b.area}`);
  assert.equal(b.holes.length, 0);
});

test('crossing shapes split into the regions you see', () => {
  const a = rect(0, 0, 10, 10), b = rect(5, 5, 10, 10);
  const ents = [...a, ...b];
  assert.ok(near(findFaceAt(ents, { x: 7, y: 7 }).area, 25));
  assert.ok(near(findFaceAt(ents, { x: 2, y: 2 }).area, 75));
  assert.ok(near(findFaceAt(ents, { x: 12, y: 12 }).area, 75));
  const faces = boundedFaces(ents);
  assert.equal(faces.length, 3);
  assert.ok(near(faces.reduce((s, f) => s + area(f), 0), 175));
});

test('a rectangle split by a line, and a spike inside a face', () => {
  const r = rect(0, 0, 10, 4);
  const split = new Line(new Point(5, 0), new Point(5, 4));          // T-junctions on top and bottom
  assert.ok(near(findFaceAt([...r, split], { x: 2, y: 2 }).area, 20));
  const spike = new Line(r[0].p1, new Point(4, 3));
  assert.ok(near(findFaceAt([...r, spike], { x: 8, y: 2 }).area, 40));
});

test('a circle crossing a rectangle', () => {
  const r = rect(0, 0, 10, 10);
  const c = new Circle(new Point(10, 5), 3);
  const inside = findFaceAt([...r, c], { x: 9, y: 5 });
  assert.ok(inside.area > 13 && inside.area < 15.2, `half disc ${inside.area}`);   // ~ pi*9/2 = 14.1
  assert.ok(findFaceAt([...r, c], { x: 2, y: 2 }).area > 80);
});

test('interiorPoint lands inside the region and outside its holes', () => {
  const f = findFaceAt([...rect(0, 0, 10, 10), new Circle(new Point(5, 5), 4)], { x: 0.5, y: 0.5 });
  const p = interiorPoint(f);
  assert.ok(regionContains(f, p));
});

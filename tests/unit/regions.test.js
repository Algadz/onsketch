import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point, Line, Circle, Arc } from '../../app/src/core/entities.js';
import { findClosedProfiles } from '../../app/src/render/regions.js';

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

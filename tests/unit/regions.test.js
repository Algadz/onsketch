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

import { findFaceAt, fillOutline } from '../../app/src/render/regions.js';

test('fill picks the smallest enclosing face, with inner shapes as holes', () => {
  const outer = rect(0, 0, 10, 10);
  const inner = rect(2, 2, 2, 2);
  const hole = new Circle(new Point(7, 7), 1);
  const ents = [...outer, ...inner, hole];
  const f = findFaceAt(ents, { x: 5, y: 1 });
  assert.deepEqual(new Set(f.outer), new Set(outer.map(e => e.id)));
  assert.equal(f.holes.length, 2);
  const g = findFaceAt(ents, { x: 3, y: 3 });
  assert.deepEqual(new Set(g.outer), new Set(inner.map(e => e.id)));
  assert.equal(g.holes.length, 0);
  assert.equal(findFaceAt(ents, { x: 20, y: 20 }), null);
});

test('fill works on a rectangle split by a line (branching graph)', () => {
  const r = rect(0, 0, 10, 4);
  const mid1 = new Point(5, 0), mid2 = new Point(5, 4);
  // rebuild bottom and top as two segments each so the splitter shares nodes
  const ents = [new Line(r[0].p1, mid1), new Line(mid1, r[0].p2), r[1],
    new Line(r[2].p1, mid2), new Line(mid2, r[2].p2), r[3], new Line(mid1, mid2)];
  const left = findFaceAt(ents, { x: 2, y: 2 });
  const right = findFaceAt(ents, { x: 8, y: 2 });
  assert.equal(left.outer.length, 4); assert.equal(right.outer.length, 4);
  assert.ok(Math.abs(left.area - 20) < 1e-9);
  assert.equal(fillOutline(ents.filter(e => left.outer.includes(e.id))).length, 1);
});

test('a spike inside a face is not part of its boundary', () => {
  const r = rect(0, 0, 10, 10);
  const spike = new Line(r[0].p1, new Point(4, 4));
  const f = findFaceAt([...r, spike], { x: 8, y: 2 });
  assert.equal(f.outer.length, 4);
  assert.ok(!f.outer.includes(spike.id));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveLinear, rowSpaceBasis, circleFrom3Points, mirrorPointAcrossLine, normAngle,
  angleOnDirectedArc, regularPolygonFromCenterEdge, lineIntersection, offsetLine,
} from '../../app/src/core/math.js';
import { near } from './helpers.js';

test('solveLinear solves a 3x3 system and rejects singular matrices', () => {
  const x = solveLinear([[2, 1, 0], [1, 3, 1], [0, 1, 4]], [3, 5, 5]);
  assert.ok(near(x[0], 1) && near(x[1], 1) && near(x[2], 1));
  assert.equal(solveLinear([[1, 2], [2, 4]], [1, 2]), null);
});

test('rowSpaceBasis reports the rank', () => {
  assert.equal(rowSpaceBasis([[1, 0, 0], [0, 1, 0], [1, 1, 0]]).length, 2);
  assert.equal(rowSpaceBasis([[1, 2], [2, 4]]).length, 1);
});

test('circleFrom3Points finds the circumcircle', () => {
  const c = circleFrom3Points({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 });
  assert.ok(near(c.x ?? c.center.x, 0) && near(c.y ?? c.center.y, 0));
  assert.ok(near(c.r, 1));
});

test('mirrorPointAcrossLine reflects about an axis', () => {
  const p = mirrorPointAcrossLine({ x: 2, y: 3 }, { p1: { x: 0, y: 0 }, p2: { x: 0, y: 10 } });
  assert.ok(near(p.x, -2) && near(p.y, 3));
});

test('angle helpers', () => {
  assert.ok(near(normAngle(-Math.PI / 2), 1.5 * Math.PI));
  assert.ok(angleOnDirectedArc(Math.PI / 2, 0, Math.PI));
  assert.ok(!angleOnDirectedArc(-Math.PI / 2, 0, Math.PI));
  assert.ok(angleOnDirectedArc(-Math.PI / 2, 0, Math.PI, true));
});

test('regular polygon vertices are equidistant from the center', () => {
  const pts = regularPolygonFromCenterEdge({ x: 0, y: 0 }, { x: 0, y: -5 }, 6);
  assert.equal(pts.length, 6);
  const r0 = Math.hypot(pts[0].x, pts[0].y);
  for (const p of pts) assert.ok(near(Math.hypot(p.x, p.y), r0));
});

test('lineIntersection and offsetLine', () => {
  const i = lineIntersection({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 });
  assert.ok(near(i.x, 1) && near(i.y, 1));
  const o = offsetLine({ p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } }, 3);
  assert.ok(near(Math.abs(o.p1.y), 3) && near(o.p1.y, o.p2.y));
});

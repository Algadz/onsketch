// Horizontal (X) and vertical (Y) distance dimensions on slanted geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/src/core/constraints.js';
import { Project } from '../../app/src/core/model.js';
import { near, sketch, line, solve } from './helpers.js';

test('X dimension sets the horizontal distance and leaves the slant free', () => {
  const s = sketch(); const l = line(s, 0, 0, 10, 6);
  s.constraints.push(new C.FixConstraint(l.p1.id, 0, 0));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 25, 'x'));
  const r = solve(s);
  assert.ok(r.residual < 1e-6, `residual ${r.residual}`);
  assert.ok(near(Math.abs(l.p2.x - l.p1.x), 25, 1e-6), `dx ${l.p2.x - l.p1.x}`);
  assert.ok(Math.abs(l.p2.y) > 1, 'still slanted');
});

test('Y dimension sets the vertical distance', () => {
  const s = sketch(); const l = line(s, 0, 0, 10, 6);
  s.constraints.push(new C.FixConstraint(l.p1.id, 0, 0));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 2.5, 'y'));
  const r = solve(s);
  assert.ok(r.residual < 1e-6, `residual ${r.residual}`);
  assert.ok(near(Math.abs(l.p2.y - l.p1.y), 2.5, 1e-6), `dy ${l.p2.y - l.p1.y}`);
});

test('X + Y dimensions together fully place a slanted line end', () => {
  const s = sketch(); const l = line(s, 0, 0, 10, 6);
  s.constraints.push(new C.FixConstraint(l.p1.id, 0, 0));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 30, 'x'));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 40, 'y'));
  const r = solve(s);
  assert.ok(r.residual < 1e-6);
  assert.ok(near(l.p2.x, 30, 1e-6) && near(l.p2.y, 40, 1e-6), `${l.p2.x}, ${l.p2.y}`);
  assert.equal(r.dof, 0);
});

test('distanceFrame: aligned, X and Y', () => {
  const a = { x: 0, y: 0 }, b = { x: -8, y: 6 };
  const al = C.distanceFrame(a, b, null);
  assert.ok(near(al.len, 10));
  const x = C.distanceFrame(a, b, 'x');
  assert.ok(near(x.len, 8) && near(x.t.x, -1) && near(x.t.y, 0));
  assert.deepEqual([x.a0.y, x.b0.y], [3, 3]);           // both ends brought to the midline
  const y = C.distanceFrame(a, b, 'y');
  assert.ok(near(y.len, 6) && near(y.t.y, 1));
  assert.deepEqual([y.a0.x, y.b0.x], [-4, -4]);
});

test('the axis is saved and loaded; aligned dimensions save no axis', () => {
  const p = new Project(); const s = p.addSketch('S');
  const l = line(s, 0, 0, 10, 6);
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 10, 'x'));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 6, 'y'));
  s.constraints.push(new C.DistanceConstraint(l.p1.id, l.p2.id, 11.66));
  const j = p.toJSON().sketches[0].constraints;
  assert.deepEqual(j.map(c => c.axis), ['x', 'y', undefined]);
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.deepEqual(back.active().constraints.map(c => c.axis), ['x', 'y', null]);
  assert.equal(C.constraintLabel(back.active().constraints[0]), 'Horizontal distance');
  assert.equal(C.constraintLabel(back.active().constraints[2]), 'Distance');
});

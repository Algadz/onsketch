import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareProjects, countText } from '../../app/src/core/compare.js';
import { ensureDimensionNames } from '../../app/src/core/equations.js';
import { Project, cleanRemix } from '../../app/src/core/model.js';
import { Point, Line, Circle } from '../../app/src/core/entities.js';
import * as C from '../../app/src/core/constraints.js';
import { remixSource } from '../../app/src/cloud/cloud.js';

/** A line with a 10 mm dimension and a Ø10 circle; the saved form. */
function base() {
  const p = new Project(); const s = p.addSketch('A');
  const a = new Line(new Point(0, 0), new Point(10, 0)); s.addEntity(a);
  const c = new Circle(new Point(30, 0), 5); s.addEntity(c);
  const d1 = new C.DistanceConstraint(a.p1.id, a.p2.id, 10);
  const d2 = new C.RadiusConstraint(c.id, 5); d2.isDiameter = true;
  s.constraints.push(d1, d2);
  p.variables = [{ name: 'w', expr: '10' }];
  ensureDimensionNames(p);
  return p.toJSON();
}

test('the same drawing compares as the same', () => {
  const json = base();
  const d = compareProjects(Project.fromJSON(json), Project.fromJSON(json));
  assert.equal(d.same, true);
  assert.deepEqual(d.dims, []);
});

test('shapes matched by id: added, removed, changed; solver noise ignored', () => {
  const json = base();
  const before = Project.fromJSON(json);
  const now = Project.fromJSON(json);
  const s = now.sketches[0];
  const [line, circle] = s.entities;
  line.p2.x = 10 + 1e-9;                                  // noise: not a change
  assert.equal(compareProjects(before, now).same, true);
  circle.r = 7;                                           // resized
  s.addEntity(new Line(new Point(0, 5), new Point(5, 5)));
  s.removeEntity(line);
  const d = compareProjects(before, now);
  assert.equal(d.shapes.added.length, 1);
  assert.equal(d.shapes.removed.length, 1);
  assert.equal(d.shapes.changed.length, 1);
  assert.equal(d.shapes.changed[0][0].r, 5);
  assert.equal(d.shapes.changed[0][1].r, 7);
  assert.equal(countText(d.shapes, 'Shapes'), 'Shapes: 1 added, 1 removed, 1 changed');
  assert.equal(countText(d.ink, 'Ink'), '');
});

test('dimensions: value and formula changes, as the user sees them (diameter)', () => {
  const json = base();
  const before = Project.fromJSON(json);
  const now = Project.fromJSON(json);
  const [dist, dia] = now.sketches[0].constraints;
  dist.value = 12.5;
  dia.expr = 'w*2';
  now.variables = [{ name: 'w', expr: '6' }, { name: 'h', expr: '3' }];
  const d = compareProjects(before, now);
  assert.deepEqual(d.dims.map(x => [x.name, x.from, x.to, x.fromExpr, x.toExpr]),
    [['D1', 10, 12.5, null, null], ['D2', 10, 10, null, 'w*2']]);
  assert.deepEqual(d.vars, [{ name: 'w', from: '10', to: '6' }, { name: 'h', from: null, to: '3' }]);
  assert.equal(d.same, false);
});

test('remix credit survives saving and is checked', () => {
  const p = Project.fromJSON(base());
  p.remixedFrom = { id: 'abc-123', name: 'Hinge', author: 'bob' };
  const json = p.toJSON();
  assert.deepEqual(Project.fromJSON(json).remixedFrom, { id: 'abc-123', name: 'Hinge', author: 'bob' });
  assert.equal(remixSource(json), 'abc-123');
  assert.equal(remixSource(base()), null);
  assert.equal(cleanRemix({ id: 'x y', name: 'n' }), null);              // not an id
  assert.equal(cleanRemix(null), null);
  assert.equal(cleanRemix({ id: 'a', name: 'x'.repeat(200) }).name.length, 80);
});

// Linear, circular and point patterns: copies, links through the solver,
// changing parameters, deleting copies / seeds / centres, saving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../app/src/core/constraints.js';
import { Project } from '../../app/src/core/model.js';
import { Arc, Circle, Line, Point } from '../../app/src/core/entities.js';
import {
  PatternConstraint, circularStep, defaultPatternParams, patternCopyCount, patternKeys, removePatternCopies, syncPattern,
} from '../../app/src/core/patterns.js';
import { near, sketch, line, circle, arc, point, solve } from './helpers.js';

const square = (s, x, y, w) => {
  const a = new Point(x, y), b = new Point(x + w, y), c = new Point(x + w, y + w), d = new Point(x, y + w);
  const ls = [new Line(a, b), new Line(b, c), new Line(c, d), new Line(d, a)];
  for (const l of ls) s.addEntity(l);
  return ls;
};

function make(s, type, params, seeds) {
  const c = new PatternConstraint(type, params, seeds.map(e => e.id));
  syncPattern(s, c);
  s.constraints.push(c);
  return c;
}

test('linear pattern: 3 × 2 copies of a circle at the spacing, both directions', () => {
  const s = sketch(); const ci = circle(s, 0, 0, 2);
  const p = defaultPatternParams('linear');
  p.d1.count = 3; p.d1.spacing = 10; p.d2.count = 2; p.d2.spacing = 5;
  const c = make(s, 'linear', p, [ci]);
  assert.equal(patternCopyCount('linear', c.params), 5);
  const circles = s.entities.filter(e => e instanceof Circle);
  assert.equal(circles.length, 6);
  const at = circles.map(e => `${Math.round(e.center.x)},${Math.round(e.center.y)}`).sort();
  assert.deepEqual(at, ['0,0', '0,5', '10,0', '10,5', '20,0', '20,5']);
  assert.ok(solve(s).ok);
});

test('linked copies follow the seed through the solver, and add no freedom', () => {
  const s = sketch(); const ls = square(s, 0, 0, 4);
  const p = defaultPatternParams('linear'); p.d1.count = 4; p.d1.spacing = 10;
  make(s, 'linear', p, ls);
  const r0 = solve(s);
  assert.equal(r0.dof, 8, 'only the seed square is free (4 points)');
  // Move the seed's corner and re-solve with it fixed there: copies follow.
  s.constraints.push(new C.FixConstraint(ls[0].p1.id, 3, 1));
  const r = solve(s);
  assert.ok(r.ok);
  const lines = s.entities.filter(e => e instanceof Line);
  assert.equal(lines.length, 16);
  const last = lines[lines.length - 4];
  assert.ok(near(last.p1.x, 33) && near(last.p1.y, 1), `copy 3 corner at (${last.p1.x}, ${last.p1.y})`);
  // copies of a closed square share their corners like the seed does
  const pts = new Set(); for (const l of lines) { pts.add(l.p1); pts.add(l.p2); }
  assert.equal(pts.size, 16);
});

test('a direction line drives the pattern: turn the line, the copies turn', () => {
  const s = sketch(); const ci = circle(s, 0, 0, 1);
  const dir = line(s, 0, -5, 10, -5);
  const p = defaultPatternParams('linear'); p.d1.count = 3; p.d1.spacing = 10; p.d1.line = { a: dir.p1.id, b: dir.p2.id };
  make(s, 'linear', p, [ci]);
  s.constraints.push(new C.FixConstraint(ci.center.id, 0, 0));
  s.constraints.push(new C.FixConstraint(dir.p1.id, 0, -5));
  s.constraints.push(new C.FixConstraint(dir.p2.id, 0, 5));   // now vertical, pointing up
  assert.ok(solve(s).ok);
  const last = s.entities.filter(e => e instanceof Circle).pop();
  assert.ok(near(last.center.x, 0, 1e-5) && near(last.center.y, 20, 1e-5), `(${last.center.x}, ${last.center.y})`);
});

test('circular pattern: equal spacing over a full turn, and the step for part turns', () => {
  assert.equal(circularStep({ count: 6, angle: 360, equal: true }), 60);
  assert.equal(circularStep({ count: 3, angle: 90, equal: true }), 45);
  assert.equal(circularStep({ count: 3, angle: 30, equal: false }), 30);
  const s = sketch(); const centre = point(s, 0, 0); const ci = circle(s, 10, 0, 1);
  const p = defaultPatternParams('circular'); p.center = { id: centre.id }; p.count = 4;
  make(s, 'circular', p, [ci]);
  const cs = s.entities.filter(e => e instanceof Circle).map(e => e.center);
  assert.equal(cs.length, 4);
  assert.ok(near(cs[1].x, 0) && near(cs[1].y, 10), 'counter-clockwise first');
  assert.ok(near(cs[2].x, -10) && near(cs[2].y, 0));
  // moving the centre moves the copies around it, not the seed
  s.constraints.push(new C.FixConstraint(centre.id, 0, 5));
  s.constraints.push(new C.FixConstraint(ci.center.id, 10, 0));
  assert.ok(solve(s).ok);
  assert.ok(near(cs[2].x, -10) && near(cs[2].y, 10), `(${cs[2].x}, ${cs[2].y})`);
});

test('circular pattern turns arcs with their copies', () => {
  const s = sketch(); const centre = point(s, 0, 0);
  const a = arc(s, 10, 0, 2, 0, Math.PI / 2);
  const p = defaultPatternParams('circular'); p.center = { id: centre.id }; p.count = 2; p.angle = 180;
  make(s, 'circular', p, [a]);
  const copy = s.entities.filter(e => e instanceof Arc)[1];
  assert.ok(near(copy.center.x, -10) && near(copy.center.y, 0));
  assert.ok(near(copy.a0, Math.PI) && near(copy.a1, 1.5 * Math.PI));
  assert.ok(solve(s).ok);
});

test('point pattern: the seed origin lands on each target, targets drive the copies', () => {
  const s = sketch(); const ls = square(s, 0, 0, 2);
  const t1 = point(s, 10, 10), t2 = point(s, -5, 20);
  const p = { origin: { id: ls[0].p1.id }, targets: [{ key: t1.id, id: t1.id }, { key: t2.id, id: t2.id }] };
  const c = make(s, 'points', p, ls);
  assert.deepEqual(patternKeys('points', c.params), [t1.id, t2.id]);
  const corners = s.entities.filter(e => e instanceof Line).map(l => l.p1);
  assert.ok(near(corners[4].x, 10) && near(corners[4].y, 10));
  assert.ok(near(corners[8].x, -5) && near(corners[8].y, 20));
  s.constraints.push(new C.FixConstraint(t2.id, 0, 30));
  s.constraints.push(new C.FixConstraint(ls[0].p1.id, 0, 0));
  assert.ok(solve(s).ok);
  assert.ok(near(corners[8].x, 0) && near(corners[8].y, 30));
});

test('changing the count keeps existing copies (same ids) and adds / removes the rest', () => {
  const s = sketch(); const ci = circle(s, 0, 0, 1);
  const p = defaultPatternParams('linear'); p.d1.count = 3; p.d1.spacing = 10;
  const c = make(s, 'linear', p, [ci]);
  const before = s.entities.filter(e => e instanceof Circle).map(e => e.id);
  c.params.d1.count = 5; syncPattern(s, c);
  const after = s.entities.filter(e => e instanceof Circle).map(e => e.id);
  assert.equal(after.length, 5);
  assert.deepEqual(after.slice(0, 3), before);
  c.params.d1.count = 2; syncPattern(s, c);
  assert.equal(s.entities.filter(e => e instanceof Circle).length, 2);
  assert.equal(c.instances.length, 1);
});

test('spacing change moves copies through the solver', () => {
  const s = sketch(); const ci = circle(s, 0, 0, 1);
  const p = defaultPatternParams('linear'); p.d1.count = 3; p.d1.spacing = 10;
  const c = make(s, 'linear', p, [ci]);
  s.constraints.push(new C.FixConstraint(ci.center.id, 0, 0));
  c.params.d1.spacing = 7;
  assert.ok(solve(s).ok);
  const last = s.entities.filter(e => e instanceof Circle).pop();
  assert.ok(near(last.center.x, 14));
});

test('deleting a copy skips that instance; deleting the seed ends the pattern', () => {
  const s = sketch(); const ci = circle(s, 0, 0, 1);
  const p = defaultPatternParams('linear'); p.d1.count = 4; p.d1.spacing = 10;
  const c = make(s, 'linear', p, [ci]);
  const copy = s.entities.filter(e => e instanceof Circle)[2];
  s.removeEntity(copy);
  assert.ok(s.constraints.includes(c));
  assert.deepEqual(c.skipped, ['2,0']);
  syncPattern(s, c);             // a later change doesn't bring it back
  assert.equal(s.entities.filter(e => e instanceof Circle).length, 3);
  s.removeEntity(ci);
  assert.ok(!s.constraints.includes(c), 'no seed, no pattern');
});

test('deleting the centre freezes it where it was', () => {
  const s = sketch(); const centre = point(s, 5, 5); const ci = circle(s, 10, 5, 1);
  const p = defaultPatternParams('circular'); p.center = { id: centre.id }; p.count = 3;
  const c = make(s, 'circular', p, [ci]);
  s.removeEntity(centre);
  assert.ok(s.constraints.includes(c));
  assert.deepEqual(c.params.center, { x: 5, y: 5 });
  assert.ok(solve(s).ok);
});

test('removePatternCopies leaves the seed', () => {
  const s = sketch(); const ls = square(s, 0, 0, 2);
  const p = defaultPatternParams('linear'); p.d1.count = 3;
  const c = make(s, 'linear', p, ls);
  removePatternCopies(s, c);
  assert.equal(s.entities.length, 4);
});

test('a pattern saves and loads with its copies still linked', () => {
  const pr = new Project(); const s = pr.addSketch('S');
  const ci = new Circle(new Point(0, 0), 1); s.addEntity(ci);
  const p = defaultPatternParams('linear'); p.d1.count = 3; p.d1.spacing = 10;
  p.exprs = { 'd1.spacing': 'D1 * 2' };
  const c = make(s, 'linear', p, [ci]);
  const back = Project.fromJSON(JSON.parse(JSON.stringify(pr.toJSON())));
  const s2 = back.sketches[0];
  const c2 = s2.constraints.find(k => k.kind === 'pattern');
  assert.ok(c2);
  assert.equal(c2.type, 'linear');
  assert.equal(c2.params.d1.spacing, 10);
  assert.equal(c2.params.exprs['d1.spacing'], 'D1 * 2');
  assert.deepEqual(c2.instances, c.instances);
  assert.equal(C.constraintLabel(c2), 'Linear pattern');
  assert.ok(solve(s2).ok);
});

test('the solver keeps a pattern in one group even with no reference points', () => {
  const s = sketch(); const a = circle(s, 0, 0, 1); const b = point(s, 0, 5);
  const p = defaultPatternParams('linear'); p.d1.count = 3; p.d1.spacing = 10;
  make(s, 'linear', p, [a, b]);
  s.constraints.push(new C.FixConstraint(a.center.id, 1, 0));
  s.constraints.push(new C.FixConstraint(b.id, 1, 5));
  const r = solve(s);
  assert.ok(r.ok);
  assert.equal(r.dof, 1, 'the seed circle radius');
});

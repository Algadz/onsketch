import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../app/src/core/model.js';
import { Point, Line, newId } from '../../app/src/core/entities.js';
import * as C from '../../app/src/core/constraints.js';

function sample() {
  const p = new Project(); const s = p.addSketch('A');
  const a = new Line(new Point(0, 0), new Point(10, 0));
  const b = new Line(a.p2, new Point(10, 10));   // shared corner
  s.addEntity(a); s.addEntity(b);
  s.constraints.push(new C.PerpendicularConstraint({ a: a.p1.id, b: a.p2.id }, { a: b.p1.id, b: b.p2.id }));
  return { p, s, a, b };
}

test('JSON round trip is stable', () => {
  const { p } = sample();
  const j = JSON.stringify(p.toJSON());
  assert.equal(JSON.stringify(Project.fromJSON(JSON.parse(j)).toJSON()), j);
});

test('shared points stay shared after revival', () => {
  const { p } = sample();
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const [a, b] = q.sketches[0].entities;
  assert.equal(a.p2, b.p1);
});

test('revival bumps the id counter past loaded ids', () => {
  const { p } = sample();
  const j = p.toJSON();
  j.sketches[0].entities[0].id = 'e999999';
  Project.fromJSON(j);
  const n = parseInt(newId().slice(1), 10);
  assert.ok(n > 999999);
});

test('removing an entity drops constraints that reference it', () => {
  const { s, b } = sample();
  s.removeEntity(b);
  assert.equal(s.constraints.length, 0);
});

test('self-referential constraints are dropped on load', () => {
  const { p, a } = sample();
  const j = p.toJSON();
  j.sketches[0].constraints.push(
    { id: 'c900', kind: 'pointOnLine', pointId: a.p2.id, l: { a: a.p2.id, b: a.p1.id } },
    { id: 'c901', kind: 'coincident', p1: a.p1.id, p2: a.p1.id });
  const q = Project.fromJSON(j);
  assert.ok(!q.sketches[0].constraints.some(c => c.id === 'c900' || c.id === 'c901'));
  assert.equal(q.sketches[0].constraints.length, 1);
});

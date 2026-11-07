import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../app/src/core/model.js';
import { Point, Line, Circle } from '../../app/src/core/entities.js';
import { resolveStyle, cleanStyle, dashFor, withAlpha } from '../../app/src/core/style.js';

test('new projects start with one active layer', () => {
  const p = new Project();
  assert.equal(p.layers.length, 1);
  assert.equal(p.activeLayer(), p.layers[0]);
});

test('entities land on the active layer when added', () => {
  const p = new Project(); const s = p.addSketch('A');
  const top = p.addLayer('Top');
  const l = new Line(new Point(0, 0), new Point(1, 0));
  s.addEntity(l);
  assert.equal(l.layerId, top.id);
  assert.equal(l.sketchId, s.id);
});

test('addLayer inserts above the active layer; moveLayer reorders', () => {
  const p = new Project(); const base = p.layers[0];
  const a = p.addLayer('A');
  p.activeLayerId = base.id;
  const b = p.addLayer('B');
  assert.deepEqual(p.layers.map(l => l.name), [base.name, 'B', 'A']);
  assert.ok(p.moveLayer(b.id, +1));
  assert.deepEqual(p.layers.map(l => l.name), [base.name, 'A', 'B']);
  assert.ok(!p.moveLayer(b.id, +1));
  assert.equal(a.name, 'A');
});

test('removeLayer deletes its geometry and keeps at least one layer', () => {
  const p = new Project(); const s = p.addSketch('A');
  const keep = p.layers[0];
  s.addEntity(new Circle(new Point(0, 0), 1));
  const extra = p.addLayer('Extra');
  s.addEntity(new Circle(new Point(5, 0), 1));
  assert.ok(p.removeLayer(extra.id));
  assert.equal(s.entities.length, 1);
  assert.equal(p.activeLayerId, keep.id);
  assert.ok(!p.removeLayer(keep.id));
});

test('layers and entity styles survive a JSON round trip', () => {
  const p = new Project(); const s = p.addSketch('A');
  const ly = p.addLayer('Holes');
  ly.locked = true; ly.opacity = 0.5;
  const c = new Circle(new Point(0, 0), 3);
  c.style = { color: '#14946b', lineWidth: 3, lineStyle: 'center' };
  s.addEntity(c);
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const ly2 = q.layer(ly.id);
  assert.equal(ly2.locked, true); assert.equal(ly2.opacity, 0.5);
  assert.deepEqual(Object.keys(ly2.toJSON()).sort(), ['id', 'locked', 'name', 'opacity', 'visible']);
  const c2 = q.sketches[0].entities[0];
  assert.equal(c2.layerId, ly.id);
  assert.deepEqual(c2.style, c.style);
  assert.equal(q.activeLayerId, ly.id);
});

test('files from when layers had colours move that look onto their entities', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const v3 = { version: 3, layers: [{ id: 'ly1', name: 'Red', color: '#d63a3a', lineWidth: 3, lineStyle: 'dashed', fill: '#e07b00', fillOpacity: 0.4 }],
    sketches: [{ id: 's1', name: 'S', entities: [
      { type: 'circle', id: 'e2', layerId: 'ly1', center: pt('e1', 0, 0), r: 2 },
      { type: 'circle', id: 'e4', layerId: 'ly1', style: { color: '#14946b' }, center: pt('e3', 5, 0), r: 2 }], constraints: [] }] };
  const p = Project.fromJSON(v3);
  const [a, b] = p.sketches[0].entities;
  assert.deepEqual(a.style, { color: '#d63a3a', lineWidth: 3, lineStyle: 'dashed', fill: '#e07b00', fillOpacity: 0.4 });
  assert.deepEqual(b.style, { color: '#14946b' });
  assert.equal(p.layers[0].color, undefined);
});

test('v2 files without layers migrate onto a default layer', () => {
  const v2 = { version: 2, name: 'old', sketches: [{ id: 's1', name: 'S', entities: [
    { type: 'circle', id: 'e2', center: { type: 'point', id: 'e1', x: 0, y: 0 }, r: 2 }], constraints: [] }] };
  const p = Project.fromJSON(v2);
  assert.equal(p.layers.length, 1);
  assert.equal(p.sketches[0].entities[0].layerId, p.layers[0].id);
});

test('resolveStyle fills in defaults; fill "none" means no fill', () => {
  const d = resolveStyle({ style: null });
  assert.equal(d.color, '#111418'); assert.equal(d.fill, null); assert.equal(d.lineStyle, 'solid');
  const r = resolveStyle({ style: { color: '#d63a3a', fill: 'none', lineWidth: 3 } });
  assert.equal(r.color, '#d63a3a'); assert.equal(r.fill, null); assert.equal(r.lineWidth, 3);
  assert.equal(resolveStyle({ style: { fill: '#e07b00' } }).fill, '#e07b00');
});

test('cleanStyle drops junk and empty objects', () => {
  assert.equal(cleanStyle({}), null);
  assert.equal(cleanStyle({ color: 'red', lineStyle: 'wavy' }), null);
  assert.deepEqual(cleanStyle({ color: '#AABBCC', lineWidth: 2, bogus: 1 }), { color: '#AABBCC', lineWidth: 2 });
});

test('dash patterns and alpha helper', () => {
  assert.deepEqual(dashFor('solid', 2), []);
  assert.ok(dashFor('dashed', 4)[0] > dashFor('dashed', 1)[0]);
  assert.equal(withAlpha('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
});

test('v2 files with several sketches become one sketch with a layer per former sketch', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const v2 = { version: 2, name: 'old', activeSketchId: 's20', sketches: [
    { id: 's10', name: 'Frame', visible: true, entities: [{ type: 'line', id: 'e3', p1: pt('e1', 0, 0), p2: pt('e2', 5, 0) }],
      constraints: [{ id: 'c4', kind: 'horizontal', lineId: 'e3', p1: 'e1', p2: 'e2' }] },
    { id: 's20', name: 'Holes', visible: false, entities: [{ type: 'circle', id: 'e6', center: pt('e5', 1, 1), r: 2 }],
      constraints: [{ id: 'c7', kind: 'radius', circleId: 'e6', value: 2 }] },
  ] };
  const p = Project.fromJSON(v2);
  assert.equal(p.sketches.length, 1);
  const s = p.sketches[0];
  assert.equal(s.visible, true);
  assert.deepEqual(p.layers.map(l => l.name), ['Frame', 'Holes']);
  assert.equal(p.layers[1].visible, false);
  assert.equal(p.activeLayer().name, 'Holes');
  assert.equal(s.entities.length, 2); assert.equal(s.constraints.length, 2);
  assert.equal(p.layerOf(s.entities[1]).name, 'Holes');
  assert.equal(s.entities[1].sketchId, s.id);
  assert.ok(!p.layers.some(l => ['e1', 'e2', 'e3', 'e5', 'e6'].includes(l.id)));
});

test('v3 files with several sketches keep their layers when merged', () => {
  const p = new Project(); const a = p.addSketch('A'); const b = p.addSketch('B');
  const ly = p.addLayer('Second');
  a.addEntity(new Circle(new Point(0, 0), 1));
  b.addEntity(new Circle(new Point(9, 0), 1));
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.equal(q.sketches.length, 1);
  assert.equal(q.layers.length, 2);
  assert.ok(q.sketches[0].entities.every(e => e.layerId === ly.id));
});

test('ownerOf finds the entity a child point belongs to', () => {
  const p = new Project(); const s = p.addSketch('A');
  const l = new Line(new Point(0, 0), new Point(1, 0)); s.addEntity(l);
  assert.equal(p.ownerOf(l.p2), l);
  assert.equal(p.ownerOf(l), l);
});

import * as C from '../../app/src/core/constraints.js';
import { Solver } from '../../app/src/core/solver.js';

test('geometry on a locked layer does not move when other layers are solved', () => {
  const p = new Project(); const s = p.addSketch('A');
  const frozen = p.layers[0];
  const a = new Line(new Point(0, 0), new Point(10, 0)); s.addEntity(a);
  p.addLayer('Work');
  const b = new Line(a.p2, new Point(13, 4)); s.addEntity(b);          // shares a corner with a
  frozen.locked = true;
  s.constraints.push(new C.DistanceConstraint(b.p1.id, b.p2.id, 8));   // only b's free end can move
  s.constraints.push(new C.HorizontalConstraint(a.id, a.p1.id, a.p2.id));
  const r = new Solver().solve(s, [s], [], { diagnostics: true });
  assert.deepEqual([a.p1.x, a.p1.y, a.p2.x, a.p2.y], [0, 0, 10, 0]);
  assert.ok(Math.abs(Math.hypot(b.p2.x - 10, b.p2.y) - 8) < 1e-6);
  assert.equal(r.entityStatus.get(a.id), 'fully');

  // A constraint that could only be met by moving locked geometry is reported, not applied.
  s.constraints.push(new C.DistanceConstraint(a.p1.id, a.p2.id, 20));
  const r2 = new Solver().solve(s, [s], [], { diagnostics: true });
  assert.equal(a.p2.x, 10);
  assert.equal(r2.state, 'over');

  frozen.locked = false;
  new Solver().solve(s, [s], [], { diagnostics: true });
  assert.ok(Math.abs(Math.hypot(a.p2.x - a.p1.x, a.p2.y - a.p1.y) - 20) < 1e-6);
});

test('new entities take the drawing style; loaded ones keep their own', () => {
  const p = new Project(); const s = p.addSketch('A');
  p.drawStyle = { color: '#14946b', lineWidth: 2 };
  const c = new Circle(new Point(0, 0), 1); s.addEntity(c);
  assert.deepEqual(c.style, { color: '#14946b', lineWidth: 2 });
  c.style = null;
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.equal(q.sketches[0].entities[0].style, null);
});

test('fill-tool fills and background survive save/load; fills drop only when all boundary entities go', () => {
  const p = new Project(); const s = p.addSketch('A');
  const a = new Line(new Point(0, 0), new Point(4, 0)), b = new Line(a.p2, new Point(0, 3)), c = new Line(b.p2, a.p1);
  for (const e of [a, b, c]) s.addEntity(e);
  s.fills.push({ id: 'f900', layerId: p.layers[0].id, color: '#8a4fd1', opacity: 0.5, ids: [a.id, b.id, c.id], seed: { x: 1, y: 1 } });
  p.background = '#e5e7eb';
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.equal(q.background, '#e5e7eb');
  assert.deepEqual(q.sketches[0].fills[0].seed, { x: 1, y: 1 });
  s.removeEntity(b);
  assert.deepEqual(s.fills[0].ids, [a.id, c.id]);
  s.removeEntity(a); s.removeEntity(c);
  assert.equal(s.fills.length, 0);
});

test('fills saved in the older outline format get an inside point on load', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const old = { version: 3, layers: [{ id: 'ly1', name: 'L' }], sketches: [{ id: 's1', name: 'S', entities: [
    { type: 'line', id: 'e3', layerId: 'ly1', p1: pt('e1', 0, 0), p2: pt('e2', 10, 0) },
    { type: 'line', id: 'e5', layerId: 'ly1', p1: pt('e2', 10, 0), p2: pt('e4', 10, 10) },
    { type: 'line', id: 'e7', layerId: 'ly1', p1: pt('e4', 10, 10), p2: pt('e6', 0, 10) },
    { type: 'line', id: 'e8', layerId: 'ly1', p1: pt('e6', 0, 10), p2: pt('e1', 0, 0) },
    { type: 'circle', id: 'e10', layerId: 'ly1', center: pt('e9', 5, 5), r: 2 }],
    constraints: [], fills: [{ id: 'f11', layerId: 'ly1', color: '#8a4fd1', opacity: 0.5, outer: ['e3', 'e5', 'e7', 'e8'], holes: [['e10']] }] }] };
  const f = Project.fromJSON(old).sketches[0].fills[0];
  assert.deepEqual(new Set(f.ids), new Set(['e3', 'e5', 'e7', 'e8', 'e10']));
  assert.ok(f.seed.x > 0 && f.seed.x < 10 && f.seed.y > 0 && f.seed.y < 10);
  assert.ok(Math.hypot(f.seed.x - 5, f.seed.y - 5) > 2, 'seed is outside the hole');
  assert.equal(f.outer, undefined);
});

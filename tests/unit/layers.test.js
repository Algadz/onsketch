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

test('layers and entity line styles survive a JSON round trip', () => {
  const p = new Project(); const s = p.addSketch('A');
  const ly = p.addLayer('Holes');
  ly.visible = false; ly.opacity = 0.5;
  const c = new Circle(new Point(0, 0), 3);
  c.style = { lineWidth: 3, lineStyle: 'center' };
  s.addEntity(c);
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const ly2 = q.layer(ly.id);
  assert.equal(ly2.visible, false); assert.equal(ly2.opacity, 0.5);
  assert.deepEqual(Object.keys(ly2.toJSON()).sort(), ['id', 'name', 'opacity', 'visible']);
  const c2 = q.sketches[0].entities[0];
  assert.equal(c2.layerId, ly.id);
  assert.deepEqual(c2.style, c.style);
  assert.equal(q.activeLayerId, ly.id);
});

test('older files: stroke colours are dropped, shape and layer fills become Fill-tool fills', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const ln = (id, a, b, extra = {}) => ({ type: 'line', id, layerId: 'ly1', p1: a, p2: b, ...extra });
  const A = pt('e1', 0, 0), B = pt('e2', 10, 0), Cc = pt('e3', 10, 10), D = pt('e4', 0, 10);
  const filled = { style: { color: '#14946b', fill: '#e07b00', fillOpacity: 0.4, lineWidth: 2 } };
  const v3 = { version: 3, layers: [{ id: 'ly1', name: 'Red', color: '#d63a3a', lineWidth: 3, lineStyle: 'dashed', fill: '#8a4fd1', fillOpacity: 0.5 }],
    sketches: [{ id: 's1', name: 'S', entities: [
      ln('e5', A, B, filled), ln('e6', B, Cc, filled), ln('e7', Cc, D, filled), ln('e8', D, A, filled),
      { type: 'circle', id: 'e10', layerId: 'ly1', center: pt('e9', 30, 0), r: 2 }], constraints: [] }] };
  const p = Project.fromJSON(v3);
  const [e5] = p.sketches[0].entities;
  const circle = p.sketches[0].entities[4];
  assert.deepEqual(e5.style, { lineWidth: 2 });
  assert.deepEqual(circle.style, { lineWidth: 3, lineStyle: 'dashed' });
  const fills = p.sketches[0].fills;
  assert.equal(fills.length, 2);
  const sq = fills.find(f => f.color === '#e07b00');
  assert.equal(sq.opacity, 0.4);
  assert.ok(sq.seed.x > 0 && sq.seed.x < 10 && sq.seed.y > 0 && sq.seed.y < 10);
  const disc = fills.find(f => f.color === '#8a4fd1');
  assert.ok(Math.hypot(disc.seed.x - 30, disc.seed.y) < 2);
  const ids = new Set([...p.sketches[0].entities.map(e => e.id), ...fills.map(f => f.id)]);
  assert.equal(ids.size, 5 + 2, 'new fill ids do not collide');
});

test('v2 files without layers migrate onto a default layer', () => {
  const v2 = { version: 2, name: 'old', sketches: [{ id: 's1', name: 'S', entities: [
    { type: 'circle', id: 'e2', center: { type: 'point', id: 'e1', x: 0, y: 0 }, r: 2 }], constraints: [] }] };
  const p = Project.fromJSON(v2);
  assert.equal(p.layers.length, 1);
  assert.equal(p.sketches[0].entities[0].layerId, p.layers[0].id);
});

test('resolveStyle fills in line defaults', () => {
  assert.deepEqual(resolveStyle({ style: null }), { lineWidth: 1.4, lineStyle: 'solid' });
  assert.deepEqual(resolveStyle({ style: { lineWidth: 3 } }), { lineWidth: 3, lineStyle: 'solid' });
});

test('cleanStyle keeps only line weight and line type', () => {
  assert.equal(cleanStyle({}), null);
  assert.equal(cleanStyle({ color: '#AABBCC', fill: '#112233', lineStyle: 'wavy' }), null);
  assert.deepEqual(cleanStyle({ color: '#AABBCC', lineWidth: 2, lineStyle: 'dashed', bogus: 1 }), { lineWidth: 2, lineStyle: 'dashed' });
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

test('geometry on unlinked layers does not move; a constraint only on it waits for its layer', () => {
  const p = new Project(); const s = p.addSketch('A');
  const frozen = p.layers[0];
  const a = new Line(new Point(0, 0), new Point(10, 0)); s.addEntity(a);
  p.addLayer('Work');                                                  // becomes the active layer
  const b = new Line(new Point(10, 5), new Point(13, 9)); s.addEntity(b);
  s.constraints.push(new C.DistanceConstraint(b.p1.id, b.p2.id, 8));
  s.constraints.push(new C.HorizontalConstraint(a.id, a.p1.id, a.p2.id));
  new Solver().solve(s, [s], [], { diagnostics: true });
  assert.deepEqual([a.p1.x, a.p1.y, a.p2.x, a.p2.y], [0, 0, 10, 0]);
  assert.ok(Math.abs(Math.hypot(b.p2.x - b.p1.x, b.p2.y - b.p1.y) - 8) < 1e-6);

  // A constraint only on held geometry is a constant while its layer is
  // inactive: ignored, not reported.
  const onA = new C.DistanceConstraint(a.p1.id, a.p2.id, 20);
  s.constraints.push(onA);
  const r2 = new Solver().solve(s, [s], [], { diagnostics: true });
  assert.equal(a.p2.x, 10);
  assert.notEqual(r2.state, 'over');

  p.activeLayerId = frozen.id;                                         // now 'a' is editable, 'b' is held
  const bBefore = [b.p1.x, b.p1.y, b.p2.x, b.p2.y];
  new Solver().solve(s, [s], [], { diagnostics: true });
  assert.ok(Math.abs(Math.hypot(a.p2.x - a.p1.x, a.p2.y - a.p1.y) - 20) < 1e-6);
  assert.deepEqual([b.p1.x, b.p1.y, b.p2.x, b.p2.y], bBefore);
});

test('layers linked by a relation or dimension solve as one; unrelated layers never move', () => {
  const p = new Project(); const s = p.addSketch('A');
  const base = p.layers[0];
  const a = new Line(new Point(0, 0), new Point(10, 0)); s.addEntity(a);
  const other = new Line(new Point(0, 50), new Point(10, 50)); s.addEntity(other);  // unrelated, same layer
  const work = p.addLayer('Work');
  const far = p.addLayer('Far');
  const lone = new Line(new Point(100, 0), new Point(110, 0)); s.addEntity(lone);   // on Far, no links
  p.activeLayerId = work.id;
  const b = new Line(new Point(0, 20), new Point(10, 20)); s.addEntity(b);
  s.constraints.push(new C.FixConstraint(b.p1.id, 0, 20), new C.FixConstraint(b.p2.id, 10, 20));
  // a dimension from the work layer to the base layer's line
  s.constraints.push(new C.DistanceConstraint(a.p1.id, b.p1.id, 5));
  s.constraints.push(new C.DistanceConstraint(a.p2.id, b.p2.id, 5));
  assert.deepEqual([...p.linkedLayers(work.id)].sort(), [base.id, work.id].sort());
  assert.deepEqual([...p.linkedLayers(far.id)], [far.id]);
  new Solver().solve(s, [s], [], { diagnostics: true });
  assert.ok(Math.abs(Math.hypot(a.p1.x - 0, a.p1.y - 20) - 5) < 1e-6, 'the base layer moved to satisfy the dimension');
  assert.ok(Math.abs(Math.hypot(a.p2.x - 10, a.p2.y - 20) - 5) < 1e-6);
  assert.deepEqual([lone.p1.x, lone.p1.y, lone.p2.x, lone.p2.y], [100, 0, 110, 0], 'an unrelated layer never moves');
  // a hidden layer keeps its relations and dimensions: it still follows
  base.visible = false;
  s.constraints.find(c => c.kind === 'distance' && c.p1 === a.p1.id).value = 7;
  new Solver().solve(s, [s], [], { diagnostics: true });
  assert.ok(Math.abs(Math.hypot(a.p1.x - 0, a.p1.y - 20) - 7) < 1e-6, 'hidden, still solved');
});

test('new entities take the drawing style; loaded ones keep their own', () => {
  const p = new Project(); const s = p.addSketch('A');
  p.drawStyle = { lineWidth: 2 };
  const c = new Circle(new Point(0, 0), 1); s.addEntity(c);
  assert.deepEqual(c.style, { lineWidth: 2 });
  c.style = null;
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.equal(q.sketches[0].entities[0].style, null);
});

test('fill-tool fills and background survive save/load; hidden paint from older files is dropped', () => {
  const p = new Project(); const s = p.addSketch('A');
  const a = new Line(new Point(0, 0), new Point(4, 0)), b = new Line(a.p2, new Point(0, 3)), c = new Line(b.p2, a.p1);
  for (const e of [a, b, c]) s.addEntity(e);
  s.fills.push({ id: 'f900', layerId: p.layers[0].id, color: '#8a4fd1', opacity: 0.5, seed: { x: 1, y: 1 }, region: { outer: [], holes: [] } });
  p.background = '#e5e7eb';
  const j = JSON.parse(JSON.stringify(p.toJSON()));
  j.sketches[0].fills.push({ id: 'f901', layerId: p.layers[0].id, color: '#14946b', opacity: 1, seed: { x: 9, y: 9 }, dormant: true, outline: [] });
  const q = Project.fromJSON(j);
  assert.equal(q.background, '#e5e7eb');
  assert.deepEqual(q.sketches[0].fills, [{ id: 'f900', layerId: p.layers[0].id, color: '#8a4fd1', opacity: 0.5, seed: { x: 1, y: 1 } }]);
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
  assert.equal(f.ids, undefined);
  assert.ok(f.seed.x > 0 && f.seed.x < 10 && f.seed.y > 0 && f.seed.y < 10);
  assert.ok(Math.hypot(f.seed.x - 5, f.seed.y - 5) > 2, 'seed is outside the hole');
  assert.equal(f.outer, undefined);
});

test('constraints belong to a layer: saved, inferred for older files, removed with their layer', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const old = { version: 3, activeLayerId: 'ly2', layers: [{ id: 'ly1', name: 'A' }, { id: 'ly2', name: 'B' }],
    sketches: [{ id: 's1', name: 'S', entities: [
      { type: 'line', id: 'e3', layerId: 'ly1', p1: pt('e1', 0, 0), p2: pt('e2', 10, 0) },
      { type: 'circle', id: 'e5', layerId: 'ly2', center: pt('e4', 30, 0), r: 2 }],
    constraints: [
      { id: 'c6', kind: 'distance', p1: 'e1', p2: 'e2', value: 10 },
      { id: 'c7', kind: 'radius', circleId: 'e5', value: 2 },
      { id: 'c8', kind: 'horizontal', lineId: 'e3', p1: 'e1', p2: 'e2', layerId: 'ly2' }] }] };
  const p = Project.fromJSON(old);
  const by = Object.fromEntries(p.sketches[0].constraints.map(c => [c.id, c.layerId]));
  assert.deepEqual(by, { c6: 'ly1', c7: 'ly2', c8: 'ly2' }, 'inferred from geometry unless already set');
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.equal(q.sketches[0].constraints.find(c => c.id === 'c6').layerId, 'ly1');
  q.removeLayer('ly2');
  assert.deepEqual(q.sketches[0].constraints.map(c => c.id), ['c6']);
});

test('editLayerId lets another layer be checked as if active', () => {
  const p = new Project(); const s = p.addSketch('A');
  const a = new Line(new Point(0, 0), new Point(1, 0)); s.addEntity(a);
  const top = p.addLayer('Top');
  const b = new Line(new Point(0, 5), new Point(1, 5)); s.addEntity(b);
  p.syncLocks();
  assert.equal(a.locked, true); assert.equal(b.locked, false);
  p.editLayerId = p.layers[0].id; p.syncLocks();
  assert.equal(a.locked, false); assert.equal(b.locked, true);
  p.editLayerId = null; p.syncLocks();
  assert.equal(p.activeLayerId, top.id); assert.equal(a.locked, true);
});

/* ---- Layers never share a point ---- */
function twoLayerCorner() {
  const p = new Project(); const s = p.addSketch('A');
  const base = p.layers[0];
  const a = new Line(new Point(0, 0), new Point(10, 0)); s.addEntity(a);           // base
  const top = p.addLayer('Top');
  const b = new Line(a.p2, new Point(10, 10)); s.addEntity(b);                      // top, shares a.p2
  const h = new C.VerticalConstraint(b.id, b.p1.id, b.p2.id); h.layerId = top.id;
  s.constraints.push(h);
  return { p, s, base, top, a, b, h };
}

test('a point shared by two layers is split, joined by a coincident on the other layer', () => {
  const { p, s, base, top, a, b, h } = twoLayerCorner();
  p.activeLayerId = base.id;
  assert.equal(p.separateLayerPoints(), 1);
  assert.notEqual(a.p2, b.p1, 'separate points');
  assert.equal(b.p1.x, 10); assert.equal(b.p1.y, 0);
  const link = s.constraints.find(c => c.kind === 'coincident');
  assert.equal(link.layerId, top.id);
  assert.deepEqual([link.p1, link.p2].sort(), [a.p2.id, b.p1.id].sort());
  assert.equal(h.p1, b.p1.id, "Top's own constraint now uses Top's copy");
  assert.equal(p.separateLayerPoints(), 0, 'idempotent');
});

test('the active layer keeps the original point', () => {
  const { p, top, a, b } = twoLayerCorner();
  const shared = a.p2;
  p.activeLayerId = top.id;
  p.separateLayerPoints();
  assert.equal(b.p1, shared); assert.notEqual(a.p2, shared);
});

test('after the split, deleting either side leaves the other where it was', () => {
  const one = twoLayerCorner();
  one.p.activeLayerId = one.base.id; one.p.separateLayerPoints();
  one.s.removeEntity(one.a);
  assert.deepEqual([one.b.p1.x, one.b.p1.y, one.b.p2.x, one.b.p2.y], [10, 0, 10, 10]);
  assert.ok(!one.s.constraints.some(c => c.kind === 'coincident'), 'the link goes with the deleted point');
  const two = twoLayerCorner();
  two.p.activeLayerId = two.base.id; two.p.separateLayerPoints();
  two.s.removeEntity(two.b);
  assert.deepEqual([two.a.p1.x, two.a.p2.x, two.a.p2.y], [0, 10, 0]);
  assert.ok(two.s.entities.includes(two.a));
});

test('older files with a point shared across layers are split on load', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const p = Project.fromJSON({ version: 3, activeLayerId: 'ly1', layers: [{ id: 'ly1', name: 'A' }, { id: 'ly2', name: 'B' }],
    sketches: [{ id: 's1', name: 'S', entities: [
      { type: 'line', id: 'e3', layerId: 'ly1', p1: pt('e1', 0, 0), p2: pt('e2', 10, 0) },
      { type: 'line', id: 'e5', layerId: 'ly2', p1: pt('e2', 10, 0), p2: pt('e4', 10, 10) }], constraints: [] }] });
  const [x, y] = p.sketches[0].entities;
  assert.notEqual(x.p2, y.p1);
  const ids = new Set([x.p1.id, x.p2.id, y.p1.id, y.p2.id]);
  assert.equal(ids.size, 4, 'the copy has a fresh id');
  assert.equal(p.sketches[0].constraints.filter(c => c.kind === 'coincident').length, 1);
});

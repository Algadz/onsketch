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

test('layers and style overrides survive a JSON round trip', () => {
  const p = new Project(); const s = p.addSketch('A');
  const ly = p.addLayer('Holes');
  ly.fill = '#d63a3a'; ly.locked = true; ly.opacity = 0.5;
  const c = new Circle(new Point(0, 0), 3);
  c.style = { color: '#14946b', lineWidth: 3, lineStyle: 'center' };
  s.addEntity(c);
  const q = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const ly2 = q.layer(ly.id);
  assert.equal(ly2.fill, '#d63a3a'); assert.equal(ly2.locked, true); assert.equal(ly2.opacity, 0.5);
  const c2 = q.sketches[0].entities[0];
  assert.equal(c2.layerId, ly.id);
  assert.deepEqual(c2.style, c.style);
  assert.equal(q.activeLayerId, ly.id);
});

test('v2 files without layers migrate onto a default layer', () => {
  const v2 = { version: 2, name: 'old', sketches: [{ id: 's1', name: 'S', entities: [
    { type: 'circle', id: 'e2', center: { type: 'point', id: 'e1', x: 0, y: 0 }, r: 2 }], constraints: [] }] };
  const p = Project.fromJSON(v2);
  assert.equal(p.layers.length, 1);
  assert.equal(p.sketches[0].entities[0].layerId, p.layers[0].id);
});

test('resolveStyle layers entity overrides on layer defaults', () => {
  const layer = { color: '#111418', lineWidth: 1.4, lineStyle: 'solid', fill: '#1f7ad6', fillOpacity: 0.3 };
  assert.deepEqual(resolveStyle({ style: null }, layer), { ...layer });
  const r = resolveStyle({ style: { color: '#d63a3a', fill: 'none' } }, layer);
  assert.equal(r.color, '#d63a3a'); assert.equal(r.fill, null); assert.equal(r.lineWidth, 1.4);
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

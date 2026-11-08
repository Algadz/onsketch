import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../app/src/core/model.js';
import { reviveStroke, simplifyPoints, strokeHit, strokeToJSON } from '../../app/src/core/strokes.js';

const stroke = (layerId, pts, extra = {}) => ({
  id: 'k1', layerId, kind: 'pen', color: '#d63a3a', opacity: 0.8, width: 2,
  points: pts.map(([x, y]) => ({ x, y })), ...extra,
});

test('strokes round-trip through project JSON', () => {
  const p = new Project(); const s = p.addSketch('S');
  s.strokes.push(stroke(p.layers[0].id, [[0, 0], [10, 5], [20, 0]], { kind: 'marker' }));
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const st = back.active().strokes;
  assert.equal(st.length, 1);
  assert.equal(st[0].kind, 'marker');
  assert.equal(st[0].color, '#d63a3a');
  assert.equal(st[0].layerId, back.layers[0].id);
  assert.deepEqual(st[0].points, [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }]);
});

test('projects without strokes save no strokes field', () => {
  const p = new Project(); p.addSketch('S');
  assert.equal(p.toJSON().sketches[0].strokes, undefined);
});

test('bad strokes are dropped and missing fields get safe values', () => {
  assert.equal(reviveStroke(null), null);
  assert.equal(reviveStroke({ pts: [] }), null);
  assert.equal(reviveStroke({ pts: ['a', 'b'] }), null);
  const s = reviveStroke({ pts: [1, 2, 3, 4], color: 'red', width: -3, opacity: 7, kind: 'spray' });
  assert.equal(s.kind, 'pen');
  assert.equal(s.color, '#111418');
  assert.equal(s.width, 1);
  assert.equal(s.opacity, 1);
});

test('a stroke on an unknown layer moves to the first layer, ids stay unique', () => {
  const p = Project.fromJSON({ version: 3, layers: [{ id: 'ly1', name: 'A' }], sketches: [{ id: 's1', name: 'S', entities: [], constraints: [],
    strokes: [{ id: 'k40', layerId: 'gone', pts: [0, 0, 1, 1] }, { layerId: 'ly1', pts: [0, 0, 2, 2] }] }] });
  const [a, b] = p.active().strokes;
  assert.equal(a.layerId, 'ly1');
  assert.ok(b.id && b.id !== a.id);
  assert.ok(parseInt(b.id.slice(1), 10) > 40);
});

test('deleting a layer deletes its strokes', () => {
  const p = new Project(); const s = p.addSketch('S');
  const base = p.layers[0], top = p.addLayer('Top');
  s.strokes.push(stroke(base.id, [[0, 0], [1, 1]]), { ...stroke(top.id, [[0, 0], [2, 2]]), id: 'k2' });
  p.removeLayer(top.id);
  assert.deepEqual(s.strokes.map(x => x.layerId), [base.id]);
});

test('saved coordinates are rounded to a thousandth', () => {
  const j = strokeToJSON(stroke('l', [[1.23456, 2.00049]]));
  assert.deepEqual(j.pts, [1.235, 2]);
});

test('simplify keeps corners and drops points on a straight run', () => {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: i, y: 0 });
  for (let i = 1; i <= 10; i++) pts.push({ x: 10, y: i });
  const out = simplifyPoints(pts, 0.01);
  assert.deepEqual(out, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
});

test('hit test counts the ink width and the eraser radius', () => {
  const s = stroke('l', [[0, 0], [10, 0]], { width: 2 });
  assert.ok(strokeHit(s, { x: 5, y: 1.5 }, 0.6));    // 1.5 ≤ 0.6 + 1
  assert.ok(!strokeHit(s, { x: 5, y: 2 }, 0.5));     // 2 > 0.5 + 1
  assert.ok(strokeHit(s, { x: 11, y: 0 }, 0.1));     // past the end: round cap
});

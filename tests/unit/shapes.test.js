import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE_IDS, shapeFrame, shapeHit, shapePaths, shapeGlyph, unitPaths } from '../../app/src/core/shapes.js';
import { inkBounds, inkInBox, reviveStroke, strokeToJSON } from '../../app/src/core/strokes.js';
import { applyTransform, rotateAbout, scaleAbout, snapshot } from '../../app/src/core/ink-transform.js';

const shape = (kind, extra = {}) => ({
  id: 'k1', layerId: 'l', kind: 'shape', shape: kind, color: '#1f7ad6', opacity: 1, width: 0.5,
  points: shapeFrame({ x: 0, y: 0 }, { x: 40, y: 20 }), ...extra,
});

test('a dragged box becomes the frame: top-left, top-right, bottom-left (y up)', () => {
  assert.deepEqual(shapeFrame({ x: 40, y: 0 }, { x: 0, y: 20 }), [{ x: 0, y: 20 }, { x: 40, y: 20 }, { x: 0, y: 0 }]);
  assert.deepEqual(shapeFrame({ x: 0, y: 0 }, { x: 40, y: 10 }, { square: true }), [{ x: 0, y: 40 }, { x: 40, y: 40 }, { x: 0, y: 0 }], 'Shift: equal sides');
  assert.deepEqual(shapeFrame({ x: 0, y: 0 }, { x: 10, y: 5 }, { center: true }), [{ x: -10, y: 5 }, { x: 10, y: 5 }, { x: -10, y: -5 }], 'Ctrl: from the middle');
});

test('every shape has an outline inside its unit box, and a glyph', () => {
  for (const id of SHAPE_IDS) {
    const paths = unitPaths(id, 2, 1);
    assert.ok(paths.length && paths.every(p => p.pts.length >= 2), id);
    for (const p of paths) for (const q of p.pts) assert.ok(q.x >= -1e-9 && q.x <= 1 + 1e-9 && q.y >= -1e-9 && q.y <= 1 + 1e-9, `${id} stays in its box`);
    assert.match(shapeGlyph(id), /<path d="M/);
  }
});

test('saved and loaded exactly, with fill and dash; unknown values are dropped', () => {
  const s = shape('star', { fill: 'tint', dash: true });
  const o = strokeToJSON(s);
  assert.equal(o.shape, 'star'); assert.equal(o.fill, 'tint'); assert.equal(o.dash, true);
  const back = reviveStroke(JSON.parse(JSON.stringify(o)));
  assert.deepEqual({ ...back, id: s.id }, { ...s });
  const odd = reviveStroke({ ...o, shape: 'blob', fill: 'plaid' });
  assert.equal(odd.shape, 'rect'); assert.equal(odd.fill, undefined);
  assert.equal(reviveStroke({ ...o, pts: [0, 0, 1, 1] }), null, 'needs its three frame points');
});

test('hit: the outline always, the inside only when filled', () => {
  const open = shape('rect'), filled = shape('rect', { fill: 'solid' });
  assert.ok(shapeHit(open, { x: 0, y: 10 }, 0.1), 'on the left side');
  assert.ok(!shapeHit(open, { x: 20, y: 10 }, 0.1), 'not inside an unfilled one');
  assert.ok(shapeHit(filled, { x: 20, y: 10 }, 0.1), 'inside a filled one');
  assert.ok(!shapeHit(filled, { x: 60, y: 10 }, 0.1));
  const check = shape('check', { fill: 'solid' });
  assert.ok(!shapeHit(check, { x: 30, y: 15 }, 0.1), 'a check mark is never filled');
});

test('bounds include the outline; box selection uses the frame', () => {
  const b = inkBounds(shape('ellipse'));
  assert.deepEqual(b, { minX: -0.25, minY: -0.25, maxX: 40.25, maxY: 20.25 });
  assert.ok(inkInBox(shape('ellipse'), -1, -1, 41, 21));
  assert.ok(!inkInBox(shape('ellipse'), 1, -1, 41, 21));
});

test('resizing and turning map the frame (rounded corners stay round)', () => {
  const s = shape('rounded');
  applyTransform(snapshot([s]), scaleAbout({ x: 0, y: 0 }, 2, 1));
  assert.deepEqual(s.points[1], { x: 80, y: 20 });
  assert.ok(Math.abs(s.width - 0.5 * Math.SQRT2) < 1e-12, 'the outline scales by the average');
  const r = shape('rect');
  applyTransform(snapshot([r]), rotateAbout({ x: 0, y: 0 }, Math.PI / 2));
  const p = shapePaths(r)[0].pts;
  assert.ok(Math.abs(p[1].x - -20) < 1e-9 && Math.abs(p[1].y - 40) < 1e-9, 'top-right corner turned a quarter');
  // corner radius in drawing units is the same along both sides of a stretched box
  const u = unitPaths('rounded', 80, 20)[0].pts;   // the top-left arc: from the left side (u[0]) to the top (u[6])
  assert.ok(Math.abs(u[0].y * 20 - 3.2) < 1e-9 && Math.abs(u[6].x * 80 - 3.2) < 1e-9, `radius 3.2 both ways (${u[0].y * 20}, ${u[6].x * 80})`);
});

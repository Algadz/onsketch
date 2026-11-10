import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransform, restore, rotateAbout, scaleAbout, snapshot } from '../../app/src/core/ink-transform.js';
import { inkHit, reviveStroke, strokeToJSON, textCenter, textCorners } from '../../app/src/core/strokes.js';
import { near } from './helpers.js';

const text = (x, y, extra = {}) => ({ kind: 'text', text: 'Hello', size: 4, color: '#000000', opacity: 1, points: [{ x, y }], ...extra });
const pen = (pts, width = 1) => ({ kind: 'pen', width, color: '#000000', opacity: 1, points: pts.map(([x, y]) => ({ x, y })) });

test('scaling maps points and scales widths and text sizes by the average scale', () => {
  const s = pen([[0, 0], [10, 0]], 2), t = text(0, 10);
  const c0 = textCenter(t);
  applyTransform(snapshot([s, t]), scaleAbout({ x: 0, y: 0 }, 2, 2));
  assert.deepEqual(s.points, [{ x: 0, y: 0 }, { x: 20, y: 0 }]);
  assert.equal(s.width, 4);
  assert.equal(t.size, 8);
  const c1 = textCenter(t);
  assert.ok(near(c1.x, c0.x * 2) && near(c1.y, c0.y * 2));
  applyTransform(snapshot([s]), scaleAbout({ x: 0, y: 0 }, 4, 1));
  assert.equal(s.width, 8);                                     // √(4 × 1) = 2
});

test('turning turns texts about their middle and keeps their size', () => {
  const t = text(0, 0);
  const c0 = textCenter(t);
  applyTransform(snapshot([t]), rotateAbout(c0, Math.PI / 2));
  assert.ok(near(t.angle, Math.PI / 2));
  const c1 = textCenter(t);
  assert.ok(near(c1.x, c0.x) && near(c1.y, c0.y));
  assert.equal(t.size, 4);
  assert.ok(inkHit(t, c0, 0));
  const xs = textCorners(t).map(p => p.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 6);           // now tall and narrow
});

test('a flip mirrors strokes but keeps texts readable', () => {
  const s = pen([[1, 0], [3, 2]]), t = text(1, 5, { angle: 0.3 });
  const c0 = textCenter(t);
  applyTransform(snapshot([s, t]), scaleAbout({ x: 0, y: 0 }, -1, 1));
  assert.deepEqual(s.points, [{ x: -1, y: 0 }, { x: -3, y: 2 }]);
  assert.ok(near(t.angle, 0.3));
  assert.ok(near(textCenter(t).x, -c0.x) && near(textCenter(t).y, c0.y));
});

test('restore undoes a transform in progress', () => {
  const s = pen([[0, 0], [1, 1]]), t = text(0, 0);
  const snap = snapshot([s, t]);
  applyTransform(snap, rotateAbout({ x: 5, y: 5 }, 1));
  restore(snap);
  assert.deepEqual(s.points, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.equal(t.angle, undefined);
  assert.deepEqual(t.points, [{ x: 0, y: 0 }]);
});

test('a text angle is saved and loaded', () => {
  const t = reviveStroke(strokeToJSON({ ...text(0, 0, { angle: -0.75 }), id: 'k1', layerId: 'l' }));
  assert.equal(t.angle, -0.75);
  assert.equal(reviveStroke(strokeToJSON({ ...text(0, 0), id: 'k1', layerId: 'l' })).angle, undefined);
});

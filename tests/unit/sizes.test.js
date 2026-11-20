import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSizes, linePxAt, niceSize, stepSize } from '../../app/src/core/sizes.js';
import { Project } from '../../app/src/core/model.js';

test('round sizes', () => {
  assert.equal(niceSize(0.35), 0.4);
  assert.equal(niceSize(0.26), 0.25);
  assert.equal(niceSize(18 / 0.003), 6000);
  assert.equal(stepSize(1, true), 1.2);
  assert.equal(stepSize(1.2, false), 1);
});

test('ink sizes are in drawing units, set once from the view', () => {
  const p = new Project(); p.addSketch('S');
  ensureSizes(p, 4);
  assert.deepEqual(p.sizes, { pen: 0.8, marker: 5, arrow: 0.5, text: 5, shape: 0.5, linePx: 1.4 });
  ensureSizes(p, 40);                        // zooming in later changes nothing
  assert.equal(p.sizes.pen, 0.8);
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.deepEqual(back.sizes, p.sizes, 'saved with the document');
  const km = new Project(); km.addSketch('S');
  ensureSizes(km, 0.003);                    // Earth–Moon in view
  assert.equal(km.sizes.text, 6000);
  assert.equal(km.sizes.linePx, 1.4, 'the line weight is px, whatever the unit');
});

test('the line weight is screen px, the same at every zoom', () => {
  assert.equal(linePxAt(1.4, 4), 1.4);       // 100 %
  assert.equal(linePxAt(1.4, 8), 1.4);       // 200 %
  assert.equal(linePxAt(1.4, 0.001), 1.4);   // far out
  assert.equal(linePxAt(0.2, 4), 0.75, 'never thinner than a hairline');
});

test('one line weight for the sketch: from older pixel files and from drawing-unit weights', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const ents = (w1, w2) => [
    { type: 'line', id: 'a', p1: pt('p', 0, 0), p2: pt('q', 400, 0), style: { lineWidth: w1 } },
    { type: 'line', id: 'b', p1: pt('q', 400, 0), p2: pt('r', 400, 100), style: { lineWidth: w1, lineStyle: 'dashed' } },
    { type: 'line', id: 'c', p1: pt('r', 400, 100), p2: pt('s', 0, 100), style: { lineWidth: w2 } }];
  const old = Project.fromJSON({ version: 3, layers: [{ id: 'l', name: 'L' }], activeLayerId: 'l', sketches: [{ id: 's', name: 'S', entities: ents(2, 3), constraints: [] }] });
  assert.equal(old.sizes.linePx, 2, 'older file: its most common pixel weight');
  assert.ok(old.sketches[0].entities.every(e => !e.style?.lineWidth));
  assert.deepEqual(old.sketches[0].entities[1].style, { lineStyle: 'dashed' }, 'the line type stays');
  const units = Project.fromJSON({ version: 3, sizes: { line: 0.4 }, layers: [{ id: 'l', name: 'L' }], activeLayerId: 'l', sketches: [{ id: 's', name: 'S', entities: ents(0.5, 0.5), constraints: [] }] });
  assert.equal(units.sizes.linePx, 2, 'weights in drawing units: × 4 px per unit at 100 %');
  assert.equal(units.sizes.line, undefined);
  const plain = Project.fromJSON({ version: 3, sizes: { line: 0.35 }, layers: [{ id: 'l', name: 'L' }], activeLayerId: 'l', sketches: [{ id: 's', name: 'S', entities: [], constraints: [] }] });
  assert.equal(plain.sizes.linePx, 1.4);
});

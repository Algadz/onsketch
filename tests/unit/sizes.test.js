import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSizes, niceSize, stepSize, fitZoom } from '../../app/src/core/sizes.js';
import { Project } from '../../app/src/core/model.js';

test('round sizes', () => {
  assert.equal(niceSize(0.35), 0.4);
  assert.equal(niceSize(0.26), 0.25);
  assert.equal(niceSize(1.4 / 4), 0.4);
  assert.equal(niceSize(18 / 0.003), 6000);
  assert.equal(stepSize(1, true), 1.2);
  assert.equal(stepSize(1.2, false), 1);
});

test('a document keeps its sizes in drawing units, whatever the zoom', () => {
  const p = new Project(); p.addSketch('S');
  ensureSizes(p, 4);                         // 4 px per mm when first used
  assert.deepEqual(p.sizes, { line: 0.4, pen: 0.8, marker: 5, arrow: 0.5, text: 5 });
  ensureSizes(p, 40);                        // zooming in later changes nothing
  assert.equal(p.sizes.pen, 0.8);
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.deepEqual(back.sizes, p.sizes, 'saved with the document');
});

test('a km drawing gets km sizes; old files keep their look', () => {
  const p = new Project(); p.addSketch('S');
  ensureSizes(p, 0.003);                     // Earth–Moon in view
  assert.equal(p.sizes.text, 6000);
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const old = Project.fromJSON({ version: 3, layers: [{ id: 'l', name: 'L' }], activeLayerId: 'l',
    sketches: [{ id: 's', name: 'S', entities: [{ type: 'line', id: 'a', p1: pt('p', 0, 0), p2: pt('q', 400, 0), style: { lineWidth: 2 } }, { type: 'line', id: 'b', p1: pt('q', 400, 0), p2: pt('r', 400, 100) }], constraints: [] }] });
  const z = fitZoom(old);
  assert.equal(z, 1100 / 400);
  const [a, b] = old.sketches[0].entities;
  assert.equal(a.style.lineWidth, niceSize(2 / z), '2 px at the fitting zoom');
  assert.equal(b.style.lineWidth, niceSize(1.4 / z), 'the old default too');
  assert.equal(old.sizes.line, niceSize(1.4 / z));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRange } from '../../app/src/app/sliders.js';
import { Project } from '../../app/src/core/model.js';

test('a slider\'s default range: 0 to a round 2× the value, a round step', () => {
  assert.deepEqual(defaultRange(40), { min: 0, max: 100, step: 1 });
  assert.deepEqual(defaultRange(3), { min: 0, max: 10, step: 0.1 });
  assert.deepEqual(defaultRange(-30), { min: -100, max: 100, step: 2 });
  assert.deepEqual(defaultRange(0), { min: 0, max: 10, step: 0.1 });
});

test('saved with its variable; a broken one is dropped', () => {
  const p = new Project(); p.addSketch('S');
  p.variables = [{ name: 'h', expr: '50', slider: { x: 1, y: 2, min: 0, max: 100, step: 1 } }, { name: 'k', expr: '2' }];
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.deepEqual(back.variables[0].slider, { x: 1, y: 2, min: 0, max: 100, step: 1 });
  assert.equal(back.variables[1].slider, undefined);
  const bad = Project.fromJSON({ ...p.toJSON(), variables: [{ name: 'h', expr: '1', slider: { x: 0, y: 0, min: 5, max: 1, step: 0 } }] });
  assert.equal(bad.variables[0].slider, undefined, 'a zero step is not kept');
  const swapped = Project.fromJSON({ ...p.toJSON(), variables: [{ name: 'h', expr: '1', slider: { x: 0, y: 0, min: 5, max: 1, step: 1 } }] });
  assert.deepEqual([swapped.variables[0].slider.min, swapped.variables[0].slider.max], [1, 5], 'min / max put in order');
});

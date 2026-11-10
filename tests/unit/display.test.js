import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, cleanDisplay, DISPLAY_DEFAULTS } from '../../app/src/core/model.js';

test('display settings round-trip with the project', () => {
  const p = new Project(); p.addSketch('S');
  p.display = { grid: false, snap: true, dimensions: false, relations: false, dimNames: true };
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.deepEqual(back.display, p.display);
});

test('files without display settings load with none (the editor keeps its setup)', () => {
  const p = new Project(); p.addSketch('S');
  const json = p.toJSON();
  assert.equal(json.display, undefined);
  assert.equal(Project.fromJSON(json).display, null);
});

test('partial or odd display settings are completed with the defaults', () => {
  assert.deepEqual(cleanDisplay({ grid: false, snap: 'yes' }), { ...DISPLAY_DEFAULTS, grid: false });
  assert.equal(cleanDisplay('grid'), null);
});

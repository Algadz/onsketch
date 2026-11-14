import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFieldValue, projectLookup, resolveFields } from '../../app/src/core/text-fields.js';
import { evaluate, setDocumentUnit } from '../../app/src/core/expr.js';
import { Project } from '../../app/src/core/model.js';

const look = (vals) => (n) => vals[n];

test('fields are computed; decimals; literal braces; errors', () => {
  const r = resolveFields('Orbit {orbit} km, speed {sqrt(360000/orbit):2}, {{x}} {nope}', look({ orbit: 20300 }));
  assert.equal(r.text, 'Orbit 20300 km, speed 4.21, {x} #?');
  assert.equal(r.errors.length, 1);
  assert.equal(resolveFields('no fields', look({})).text, 'no fields');
  assert.equal(formatFieldValue(2.5), '2.5');
  assert.equal(formatFieldValue(2.004), '2');
  assert.equal(formatFieldValue(-0.001), '0');
  assert.equal(formatFieldValue(2, 3), '2.000');
});

test('projectLookup reads dimensions (as shown) and evaluates variables of a loaded project', () => {
  const pt = (id, x, y) => ({ type: 'point', id, x, y });
  const p = Project.fromJSON({ version: 3, units: 'km', variables: [{ name: 'a', expr: '2*b' }, { name: 'b', expr: '21' }],
    layers: [{ id: 'l', name: 'L' }], activeLayerId: 'l', sketches: [{ id: 's', name: 'S', entities: [{ type: 'circle', id: 'c', center: pt('o', 0, 0), r: 5 }],
      constraints: [{ id: 'd', kind: 'radius', circleId: 'c', value: 5, isDiameter: true, name: 'D1' }] }] });
  const r = resolveFields('{D1} {a} {D1*a}', projectLookup(p));
  assert.equal(r.text, '10 42 420');
  assert.equal(p.units, 'km');
});

test('typed units convert into the document unit', () => {
  try {
    setDocumentUnit('km');
    assert.equal(evaluate('384400'), 384400);
    assert.equal(evaluate('3474800m / 2'), 1737.4);
    assert.ok(Math.abs(evaluate('1mi') - 1.609344) < 1e-12);
    assert.equal(evaluate('500mm'), 0.0005);
    assert.equal(evaluate('30deg'), 30);
    setDocumentUnit('mm');
    assert.equal(evaluate('2km'), 2e6);
    assert.equal(evaluate('1in'), 25.4);
    setDocumentUnit('furlong');
    assert.equal(evaluate('1m'), 1000, 'unknown units fall back to mm');
  } finally { setDocumentUnit('mm'); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDXF, dxfToSketchData } from '../../app/src/core/dxf-import.js';
import { toDXF } from '../../app/src/core/dxf.js';
import { Project } from '../../app/src/core/model.js';

const dxf = (entities, units = 4) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join('\r\n');
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('round trip: what OnSketch exports comes back as the same shapes, joined', () => {
  const P = (id, x, y) => ({ type: 'point', id, x, y });
  const p = Project.fromJSON({ version: 3, units: 'mm', activeLayerId: 'l', layers: [{ id: 'l', name: 'Plate' }], sketches: [{ id: 's', name: 'S', entities: [
    { type: 'line', id: 'a', p1: P('a1', 0, 0), p2: P('a2', 40, 0) },
    { type: 'line', id: 'b', p1: P('b1', 40, 0), p2: P('b2', 40, 20) },
    { type: 'arc', id: 'c', center: P('c0', 20, 20), r: 20, a0: 0, a1: Math.PI, clockwise: false },
    { type: 'line', id: 'd', p1: P('d1', 0, 20), p2: P('d2', 0, 0) },
    { type: 'circle', id: 'h', center: P('h0', 20, 10), r: 3 },
  ], constraints: [] }] });
  const { text } = toDXF(p);
  const { data, count, unit } = dxfToSketchData(text, 'mm', 'Plate');
  assert.equal(count, 5); assert.equal(unit, 'mm');
  const back = Project.fromJSON(data).sketches[0];
  const kinds = back.entities.map(e => e.constructor.kind).sort();
  assert.deepEqual(kinds, ['arc', 'circle', 'line', 'line', 'line']);
  const arc = back.entities.find(e => e.constructor.kind === 'arc');
  assert.ok(near(arc.r, 20) && near(arc.center.x, 20) && near(arc.center.y, 20) && near(arc.a1 - arc.a0, Math.PI));
  // the outline's 4 corners are joined: 2 line–line, 2 line–arc
  const ks = back.constraints.map(c => c.kind).sort();
  assert.deepEqual(ks, ['arcEndpointCoincident', 'arcEndpointCoincident', 'coincident', 'coincident']);
  assert.equal(data.layers[0].name, 'PLATE');
});

test('LWPOLYLINE: straight and bulged segments, closed; a rounded slot', () => {
  // slot 0..20 × ±5: right end a half circle (bulge 1 = 180° counter-clockwise), left end too
  const text = dxf(['0', 'LWPOLYLINE', '8', 'CUT', '90', '4', '70', '1',
    '10', '0', '20', '-5', '10', '20', '20', '-5', '42', '1', '10', '20', '20', '5', '10', '0', '20', '5', '42', '1']);
  const r = readDXF(text);
  assert.deepEqual(r.shapes.map(s => s.kind), ['line', 'arc', 'line', 'arc']);
  const right = r.shapes[1];
  assert.ok(near(right.c.x, 20) && near(right.c.y, 0) && near(right.r, 5), JSON.stringify(right));
  const left = r.shapes[3];
  assert.ok(near(left.c.x, 0) && near(left.c.y, 0) && near(left.r, 5));
  const { data } = dxfToSketchData(text);
  assert.equal(data.sketches[0].constraints.length, 4, 'four joints, closed');
  assert.equal(data.layers[0].name, 'CUT');
});

test('units: inches into a mm drawing; no units means mm; cm into an inch drawing', () => {
  const line = ['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '2', '21', '0'];
  const inch = dxfToSketchData(dxf(line, 1), 'mm').data.sketches[0].entities[0];
  assert.ok(near(inch.p2.x, 50.8));
  const none = dxfToSketchData(dxf(line, 0), 'mm');
  assert.equal(none.unit, null); assert.ok(near(none.data.sketches[0].entities[0].p2.x, 2));
  const cm = dxfToSketchData(dxf(line, 5), 'in').data.sketches[0].entities[0];
  assert.ok(near(cm.p2.x, 20 / 25.4));
});

test('mirrored arcs (extrusion −1) are flipped back; text and splines are counted, not read', () => {
  const r = readDXF(dxf(['0', 'ARC', '8', '0', '10', '10', '20', '0', '40', '5', '50', '0', '51', '90', '230', '-1',
    '0', 'TEXT', '8', '0', '1', 'hello', '0', 'SPLINE', '8', '0', '0', 'TEXT', '8', '0']));
  const a = r.shapes[0];
  assert.ok(near(a.c.x, -10) && near(a.a0, Math.PI / 2) && near(a.a1, Math.PI), JSON.stringify(a));
  assert.deepEqual(r.skipped, { TEXT: 2, SPLINE: 1 });
});

test('not a DXF, or no shapes', () => {
  assert.throws(() => readDXF('hello'), /not an ASCII DXF/);
  assert.throws(() => readDXF('0\r\nSECTION\r\n2\r\nHEADER\r\n0\r\nENDSEC\r\n0\r\nEOF'), /no shapes/);
});

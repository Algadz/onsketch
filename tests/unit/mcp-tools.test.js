// edit_sketch, check_sketch, exact readback, previews, conflicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, createTools, applyChanges } from '../../supabase/functions/mcp/server.js';
import { Project } from '../../app/src/core/model.js';

const ID = '11111111-2222-4333-8444-555555555555';
const renderPng = async (svg) => { assert.match(svg, /^<svg/); return new Uint8Array([137, 80, 78, 71]); };
function fakeStore() {
  const db = new Map();
  return {
    userId: 'me', db,
    async plan() { return { plan: 'premium', limit: null, canPrivate: true }; },
    async list() { return [...db.values()]; },
    async load(id) { const r = db.get(id); if (!r) throw new Error('not found'); return JSON.parse(JSON.stringify(r)); },
    async create(json, details) { const row = { id: ID, owner_id: 'me', revision: 1, data: json, ...details }; db.set(ID, row); return row; },
    async save(id, json, revision) {
      const r = db.get(id);
      if (r.revision !== revision) { const e = new Error('changed'); e.name = 'ConflictError'; throw e; }
      r.data = JSON.parse(JSON.stringify(json)); r.revision++; return r;
    },
  };
}
const call = (tools, name, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools);
const text = (res) => res.result.content[0].text;
const data = (res) => res.result.structuredContent;

const SPEC = {
  variables: { L: 40 },
  layers: ['Part', 'Paint'],
  shapes: [
    { id: 'frame', type: 'rectangle', corner: [0, 0], width: 80, height: 30, layer: 'Part' },
    { id: 'arm', type: 'bar', from: [20, 15], to: [55, 15], width: 8, hole: 3, layer: 'Part' },
  ],
  constraints: [
    { id: 'origin', type: 'fix', point: 'frame.bl' },
    { id: 'w', type: 'length', line: 'frame.bottom', value: 80, name: 'width' },
    { type: 'length', line: 'arm.axis', value: 'L', name: 'armL' },
  ],
  fills: [{ at: [5, 5], color: '#cfe3ff' }],                     // on the layer whose shapes enclose it
  drawing: [{ id: 'title', type: 'text', text: 'Arm', at: [20, 40], align: 'left', size: 4, layer: 'Paint', link: 'arm' }],
};

test('create returns a picture, values and what is still free; get_sketch gives the spec back exactly', async () => {
  const store = fakeStore();
  const tools = createTools(store, { renderPng });
  const made = await call(tools, 'create_sketch', { title: 'Arm', description: 'An arm on a frame.', spec: SPEC });
  assert.equal(made.result.isError, false, text(made));
  assert.equal(made.result.content[1].type, 'image');
  assert.equal(data(made).values.armL, 40);
  assert.ok(data(made).free.length > 0);
  const got = await call(tools, 'get_sketch', { id: ID });
  assert.equal(data(got).exact, true);
  assert.deepEqual(data(got).spec, SPEC, 'ids, groups, alignment, layers: as sent');
  assert.deepEqual({ L: data(got).values.L, width: data(got).values.width, armL: data(got).values.armL, D1: data(got).values.D1 }, { L: 40, width: 80, armL: 40, D1: 8 }, 'variables, named dimensions, and the bar\'s own (width D1)');
  // edited in OnSketch: worked out from the drawing, names kept
  const row = store.db.get(ID);
  const p = Project.fromJSON(row.data);
  p.active().entities.find(e => e.constructor.kind === 'line').p1.x -= 1;
  row.data = p.toJSON(); row.revision++;
  const again = data(await call(tools, 'get_sketch', { id: ID }));
  assert.equal(again.exact, false);
  assert.ok(again.spec.shapes.some(s => s.id === 'frame.bottom') && again.spec.shapes.some(s => s.id === 'arm.axis'));
  assert.ok(again.spec.constraints.some(c => c.id === 'origin'));
  assert.ok(again.spec.drawing.some(d => d.id === 'title' && d.layer === 'Paint'));
});

test('edit_sketch: changes part of it, on the latest version, keeping edits made in OnSketch', async () => {
  const store = fakeStore();
  const tools = createTools(store, { renderPng });
  await call(tools, 'create_sketch', { title: 'Arm', description: 'An arm on a frame.', spec: SPEC });
  const ed = await call(tools, 'edit_sketch', { id: ID, changes: {
    variables: { L: 30 },
    update: { drawing: [{ id: 'title', text: 'Short arm', color: '#d63a3a' }] },
    add: { drawing: [{ id: 'mark', type: 'shape', shape: 'ellipse', center: 'arm.end', width: 10, height: 10, fill: 'tint', outline: 'none', link: 'arm' }] },
  } });
  assert.equal(ed.result.isError, false, text(ed));
  assert.equal(data(ed).values.armL, 30);
  const spec = data(await call(tools, 'get_sketch', { id: ID })).spec;
  assert.equal(spec.drawing[0].text, 'Short arm');
  assert.equal(spec.drawing[0].align, 'left');
  assert.equal(spec.drawing.length, 2);
  assert.equal(spec.shapes.length, 2, 'CAD untouched');
  // removing a shape takes the constraints that use it
  const rm = await call(tools, 'edit_sketch', { id: ID, changes: { remove: { shapes: ['arm'], drawing: ['title', 'mark'] } } });
  assert.match(text(rm), /also removed 1 constraint/);
  // a stale revision is refused, saying where it stands
  const stale = await call(tools, 'edit_sketch', { id: ID, revision: 1, changes: { variables: { L: 20 } } });
  assert.match(text(stale), /no longer at revision 1\. It is now at revision 3.*ids: frame/);
  // unknown ids: nothing changed
  const bad = await call(tools, 'edit_sketch', { id: ID, changes: { update: { shapes: [{ id: 'nope', width: 3 }] } } });
  assert.match(text(bad), /Nothing was changed:\n- changes\.update\.shapes: no item "nope"/);
});

test('applyChanges: positions, points, layers, replace', () => {
  const { spec } = applyChanges(SPEC, {
    remove: { constraints: [0], layers: ['Paint'] },
    update: { points: { P: [1, 2] } },
    replace: { drawing: [], fills: [] },
  });
  assert.equal(spec.constraints.length, 2);
  assert.deepEqual(spec.layers, ['Part']);
  assert.deepEqual(spec.points, { P: [1, 2] });
  assert.deepEqual(spec.drawing, []);
  assert.throws(() => applyChanges(SPEC, { replace: { shapes: [] } }), /only drawing, fills/);
});

const CRANK = {
  variables: { a: { value: 60, slider: true } },
  points: { o: [0, 0] },
  shapes: [
    { id: 'ground', type: 'line', from: [-20, 0], to: [70, 0], construction: true },
    { id: 'crank', type: 'bar', from: 'o', to: [5, 8.660254], width: 4 },
    { id: 'rod', type: 'bar', from: 'crank.end', to: [28.452079, 0], width: 4 },
  ],
  constraints: [
    { type: 'fix', point: 'o' }, { type: 'fix', point: 'ground.start' }, { type: 'fix', point: 'ground.end' },
    { type: 'length', line: 'crank.axis', value: 10 }, { type: 'length', line: 'rod.axis', value: 25 },
    { type: 'on', point: 'rod.end', shape: 'ground' },
    { type: 'angle', a: 'ground', b: 'crank.axis', value: 'a', signed: true },
  ],
};

test('check_sketch: dry run, other values, a sweep with positions, pictures; nothing saved', async () => {
  const store = fakeStore();
  const tools = createTools(store, { renderPng });
  const r = await call(tools, 'check_sketch', { spec: CRANK, values: { a: 90 }, points: ['crank.end', 'rod.end'] });
  assert.equal(r.result.isError, false, text(r));
  const at = data(r).at;
  assert.ok(at.ok);
  assert.deepEqual(at.points['crank.end'], [0, 10]);
  assert.ok(Math.abs(at.points['rod.end'][0] - Math.sqrt(625 - 100)) < 1e-3);
  const sw = data(await call(tools, 'check_sketch', { spec: CRANK, sweep: { variable: 'a', from: 0, to: 360, steps: 12 }, points: ['rod.end'] })).sweep;
  assert.equal(sw.ok, true);
  assert.equal(sw.steps.length, 13);
  const xs = sw.steps.map(s => s['rod.end'][0]);
  assert.ok(Math.abs(Math.min(...xs) - 15) < 1e-3 && Math.abs(Math.max(...xs) - 35) < 1e-3, 'the slider runs 15 to 35');
  // a rod that reaches the rail at 60° but not at 90° (18.5 < 9 + 10): where it fails
  const short = JSON.parse(JSON.stringify(CRANK));
  short.shapes[0] = { id: 'ground', type: 'line', from: [-20, -9], to: [70, -9], construction: true };
  short.shapes[2].to = [5 + Math.sqrt(18.5 ** 2 - 17.660254 ** 2), -9];
  short.constraints[4].value = 18.5;
  const g = await call(tools, 'check_sketch', { spec: short, sweep: { variable: 'a', from: 60, to: 120, steps: 60 } });
  if (!data(g).ok) assert.fail(text(g));
  assert.equal(data(g).sweep.ok, false);
  const failedAt = data(g).sweep.failed_at;
  assert.ok(failedAt > 70 && failedAt < 73, `fails near 71° (asin((18.5 - 9) / 10)): ${failedAt}`);
  assert.match(text(g), /can't be solved at a = /);
  const pics = await call(tools, 'check_sketch', { spec: CRANK, sweep: { variable: 'a', from: 0, to: 90, steps: 2 }, render: [0, 45, 90] });
  assert.equal(pics.result.content.filter(c => c.type === 'image').length, 3);
  const broken = await call(tools, 'check_sketch', { spec: { shapes: [{ type: 'circle', center: 'X', r: 1 }] } });
  assert.equal(data(broken).ok, false);
  assert.match(data(broken).problems[0], /unknown point "X"/);
  assert.equal(store.db.size, 0, 'nothing saved');
});

// The MCP server's protocol and tools, against a fake store.
// (npm test copies app/src into supabase/functions/mcp/_app first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, createTools, TOOLS, FORMAT, inlineImages } from '../../supabase/functions/mcp/server.js';
import { pngDataUrl } from './helpers.js';
import { buildFromSpec } from '../../app/src/core/spec.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const SPEC = { shapes: [{ id: 'r', type: 'rectangle', corner: [0, 0], width: 40, height: 20 }, { type: 'circle', center: [10, 10], d: 5 }] };

function fakeStore({ plan = 'premium', rows = [] } = {}) {
  const db = new Map(rows.map(r => [r.id, r]));
  return {
    userId: 'me', db, created: [],
    async plan() { return plan === 'premium' ? { plan, limit: null, canPrivate: true } : { plan, limit: 3, canPrivate: false }; },
    async list() { return [...db.values()].filter(r => r.owner_id === 'me'); },
    async load(id) { const r = db.get(id); if (!r) throw new Error('not found'); return r; },
    async create(json, details) {
      const row = { id: ID, owner_id: 'me', revision: 1, data: json, ...details };
      db.set(ID, row); this.created.push(row); return row;
    },
    async save(id, json, revision) {
      const r = db.get(id);
      if (r.revision !== revision) { const e = new Error('changed'); e.name = 'ConflictError'; throw e; }
      r.data = json; r.revision++; return r;
    },
  };
}
const call = (tools, name, args, id = 1) => handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, tools);
const text = (res) => res.result.content[0].text;

test('initialize, tools/list, ping, notifications, unknown methods', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, null);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.serverInfo.name, 'onsketch');
  const future = await handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, null);
  assert.equal(future.result.protocolVersion, '2025-11-25');
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, null);
  assert.deepEqual(list.result.tools.map(t => t.name), ['create_sketch', 'update_sketch', 'get_sketch', 'export_sketch', 'list_sketches']);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object');
  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, null)).result, {});
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, null), null);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, null)).error.code, -32601);
  assert.equal((await handleMessage({ nope: 1 }, null)).error.code, -32600);
});

test('create_sketch saves a private sketch for Pro and returns the edit link', async () => {
  const store = fakeStore();
  const res = await call(createTools(store), 'create_sketch', { title: 'Plate', description: 'A plate with a hole.', spec: SPEC });
  assert.equal(res.result.isError, false, text(res));
  assert.match(text(res), new RegExp(`https://onsketch.io/app/\\?project=${ID}`));
  assert.equal(res.result.structuredContent.visibility, 'private');
  const row = store.created[0];
  assert.equal(row.name, 'Plate');
  assert.equal(row.data.name, 'Plate');
  assert.equal(row.data.sketches[0].entities.length, 5);
});

test('free plan: asks before making a public sketch, and stops at the limit', async () => {
  const store = fakeStore({ plan: 'free' });
  const tools = createTools(store);
  const ask = await call(tools, 'create_sketch', { title: 'Plate', description: 'A plate with a hole.', spec: SPEC });
  assert.equal(ask.result.isError, true);
  assert.match(text(ask), /public/);
  assert.equal(store.created.length, 0);
  const priv = await call(tools, 'create_sketch', { title: 'Plate', description: 'A plate with a hole.', visibility: 'private', spec: SPEC });
  assert.match(text(priv), /need OnSketch Pro/);
  const ok = await call(tools, 'create_sketch', { title: 'Plate', description: 'A plate with a hole.', visibility: 'public', spec: SPEC });
  assert.equal(ok.result.isError, false);
  const full = fakeStore({ plan: 'free', rows: [1, 2, 3].map(i => ({ id: `id${i}`, owner_id: 'me' })) });
  const res = await call(createTools(full), 'create_sketch', { title: 'Plate', description: 'A plate with a hole.', visibility: 'public', spec: SPEC });
  assert.match(text(res), /holds 3 sketches/);
});

test('bad specs come back as problems the assistant can fix', async () => {
  const res = await call(createTools(fakeStore()), 'create_sketch', { title: 'Bad', description: 'Not a valid sketch.', spec: { shapes: [{ type: 'circle', center: 'X', r: 1 }] } });
  assert.equal(res.result.isError, true);
  assert.match(text(res), /unknown point "X"/);
  const short = await call(createTools(fakeStore()), 'create_sketch', { title: 'Ok title', description: 'short', spec: SPEC });
  assert.match(text(short), /10 to 500/);
});

test('get_sketch then update_sketch, with the revision check', async () => {
  const { project } = buildFromSpec(SPEC, { title: 'Plate' });
  const store = fakeStore({ rows: [{ id: ID, owner_id: 'me', name: 'Plate', visibility: 'private', revision: 4, data: project.toJSON() }] });
  const tools = createTools(store);
  const got = await call(tools, 'get_sketch', { id: `https://onsketch.io/app/?project=${ID}` });
  assert.equal(got.result.isError, false, text(got));
  const { spec, revision, editable } = got.result.structuredContent;
  assert.equal(revision, 4);
  assert.equal(editable, true);
  // make the rectangle wider: move the right-hand corners
  const wider = JSON.parse(JSON.stringify(spec));
  for (const [k, [x, y]] of Object.entries(wider.points)) if (x === 40) wider.points[k] = [60, y];
  const up = await call(tools, 'update_sketch', { id: ID, revision: 4, spec: wider });
  assert.equal(up.result.isError, false, text(up));
  assert.equal(store.db.get(ID).revision, 5);
  const xs = store.db.get(ID).data.sketches[0].entities.flatMap(e => e.p1 ? [e.p1.x, e.p2.x] : []);
  assert.equal(Math.max(...xs), 60);
  const stale = await call(tools, 'update_sketch', { id: ID, revision: 4, spec: wider });
  assert.match(text(stale), /changed since it was read/);
});

test('someone else\'s public sketch can be read, not changed; lossy sketches are not replaced', async () => {
  const { project } = buildFromSpec(SPEC);
  const json = project.toJSON();
  const lossy = { ...json, sketches: [{ ...json.sketches[0], strokes: [{ id: 'k1', layerId: json.layers[0].id, kind: 'image', image: 'im1', opacity: 1, pts: [1, 1, 0, 1, 1, 0] }] }] };
  const store = fakeStore({ rows: [
    { id: OTHER, owner_id: 'them', name: 'Theirs', visibility: 'public', revision: 1, data: json },
    { id: ID, owner_id: 'me', name: 'Filled', visibility: 'private', revision: 1, data: lossy },
  ] });
  const tools = createTools(store);
  const theirs = await call(tools, 'get_sketch', { id: OTHER });
  assert.equal(theirs.result.structuredContent.editable, false);
  assert.match(text(await call(tools, 'update_sketch', { id: OTHER, revision: 1, spec: SPEC })), /belongs to someone else/);
  assert.match(text(await call(tools, 'update_sketch', { id: ID, revision: 1, spec: SPEC })), /can't carry \(stretched or flipped pictures\)/);
});

test('list_sketches and unexpected failures', async () => {
  const store = fakeStore({ rows: [{ id: ID, owner_id: 'me', name: 'Plate', visibility: 'private', updated_at: '2026-11-28' }] });
  const res = await call(createTools(store), 'list_sketches', {});
  assert.equal(res.result.structuredContent.sketches[0].url, `https://onsketch.io/app/?project=${ID}`);
  store.list = async () => { throw new Error('db down'); };
  const logged = [];
  const bad = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_sketches', arguments: {} } }, createTools(store), { log: (...a) => logged.push(a) });
  assert.equal(bad.result.isError, true);
  assert.doesNotMatch(text(bad), /db down/);
  assert.equal(logged.length, 1);
});

test('the example in the format guide draws, fully defined', () => {
  const example = FORMAT.slice(FORMAT.indexOf('{', FORMAT.indexOf('Example (')));
  const { report } = buildFromSpec(JSON.parse(example));
  assert.equal(report.state, 'fully');
});

test('export_sketch: SVG to look at, DXF at real size', async () => {
  const { project } = buildFromSpec(SPEC, { title: 'Plate' });
  const store = fakeStore({ rows: [{ id: ID, owner_id: 'me', name: 'Plate', visibility: 'private', revision: 1, data: project.toJSON() }] });
  const tools = createTools(store);
  const svg = await call(tools, 'export_sketch', { id: ID });
  assert.equal(svg.result.isError, false, text(svg));
  assert.match(text(svg), /^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(text(svg), /<title>Plate<\/title>/);
  const dxf = await call(tools, 'export_sketch', { id: ID, format: 'dxf' });
  assert.match(text(dxf), /SECTION/);
  assert.equal(dxf.result.structuredContent.shapes, 5);
  assert.match(text(await call(tools, 'export_sketch', { id: ID, format: 'pdf' })), /"svg" or "dxf"/);
});

test('pictures from https links are downloaded; others refused; pictures survive an update', async () => {
  const png = pngDataUrl(4, 2);
  const bytes = Buffer.from(png.split(',')[1], 'base64');
  const asked = [];
  const fetchImage = async (url) => { asked.push(url); return { ok: true, status: 200, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => bytes }; };
  const spec = { shapes: [{ type: 'line', from: [0, 0], to: [10, 0] }], drawing: [{ type: 'image', src: 'https://example.com/logo.png', center: [5, 5], width: 4 }] };
  const out = await inlineImages(spec, fetchImage);
  assert.deepEqual(asked, ['https://example.com/logo.png']);
  assert.equal(out.drawing[0].src, png);
  for (const bad of ['http://example.com/a.png', 'https://localhost/a.png', 'https://10.0.0.1/a.png']) {
    await assert.rejects(inlineImages({ ...spec, drawing: [{ ...spec.drawing[0], src: bad }] }, fetchImage), /public https links/);
  }
  const notImage = async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), arrayBuffer: async () => Buffer.from('<html>') });
  await assert.rejects(inlineImages(spec, notImage), /isn't a PNG/);

  const store = fakeStore();
  const tools = createTools(store, { fetchImage });
  const made = await call(tools, 'create_sketch', { title: 'Logo', description: 'A line with a logo.', spec });
  assert.equal(made.result.isError, false, text(made));
  const got = await call(tools, 'get_sketch', { id: ID });
  const back = got.result.structuredContent.spec;
  assert.match(back.drawing[0].src, /^image:im/, 'read back as a reference, not data');
  const broken = JSON.parse(JSON.stringify(back));
  broken.shapes[0].to = 'e999';                  // an unknown point: refused, nothing saved
  assert.equal((await call(tools, 'update_sketch', { id: ID, revision: 1, spec: broken })).result.isError, true);
  const wider = JSON.parse(JSON.stringify(back));
  wider.drawing[0].width = 8;
  const up = await call(tools, 'update_sketch', { id: ID, revision: 1, spec: wider });
  assert.equal(up.result.isError, false, text(up));
  const saved = store.db.get(ID).data;
  assert.equal(Object.values(saved.images)[0], png, 'the picture is still in the sketch');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Project } from '../../app/src/core/model.js';
import { Point, Line, Circle } from '../../app/src/core/entities.js';
import * as C from '../../app/src/core/constraints.js';
import { insertProject, renameInFormula } from '../../app/src/core/insert.js';
import { Solver } from '../../app/src/core/solver.js';

/** A 20 × 10 part pinned at the origin, with a hole, one named dimension,
 *  a fill, a text and a variable. */
function part() {
  const p = new Project(); p.name = 'Socket';
  const s = p.addSketch('S');
  const a = new Point(0, 0), b = new Point(20, 0), c = new Point(20, 10), d = new Point(0, 10);
  const L = [new Line(a, b), new Line(b, c), new Line(c, d), new Line(d, a)];
  L.forEach(l => s.addEntity(l));
  const hole = new Circle(new Point(10, 5), 2); s.addEntity(hole);
  s.constraints.push(new C.FixConstraint(a.id, 0, 0));
  s.constraints.push(new C.HorizontalConstraint(L[0].id, a.id, b.id));
  const w = new C.DistanceConstraint(a.id, b.id, 20); w.name = 'D1'; w.expr = 'w';
  s.constraints.push(w);
  p.variables = [{ name: 'w', expr: '20' }];
  s.fills.push({ id: 'f1', layerId: p.activeLayerId, color: '#ff0000', opacity: 0.4, seed: { x: 3, y: 3 } });
  s.strokes.push({ id: 'k1', layerId: p.activeLayerId, kind: 'text', color: '#111111', opacity: 1, size: 3, text: 'p1', points: [{ x: 2, y: 8 }] });
  return JSON.parse(JSON.stringify(p.toJSON()));
}
function host() {
  const p = new Project(); const s = p.addSketch('Host');
  const l = new Line(new Point(-50, 0), new Point(50, 0)); s.addEntity(l);
  const d = new C.DistanceConstraint(l.p1.id, l.p2.id, 100); d.name = 'D1';
  s.constraints.push(d);
  p.variables = [{ name: 'w', expr: '100' }];
  return p;
}
const allIds = (p) => {
  const ids = [], seen = new Set();
  const walk = (e) => { if (seen.has(e)) return; seen.add(e); ids.push(e.id); for (const c of e.children()) walk(c); };   // shared corners count once
  for (const s of p.sketches) { s.entities.forEach(walk); s.constraints.forEach(c => ids.push(c.id)); s.strokes.forEach(k => ids.push(k.id)); s.fills.forEach(f => ids.push(f.id)); }
  p.layers.forEach(l => ids.push(l.id));
  return ids;
};

test('formulas are renamed by whole identifier', () => {
  assert.equal(renameInFormula('D1*2 + D10 + w', new Map([['D1', 'D7'], ['w', 'w_2']])), 'D7*2 + D10 + w_2');
});

test('an inserted part lands where asked, with fresh ids, on its own layer', () => {
  const p = host();
  const before = p.layers.length;
  const res = insertProject(p, part(), { at: { x: 200, y: 100 } });
  const s = p.active();
  assert.equal(res.entityIds.length, 5);
  assert.equal(p.layers.length, before + 1);
  assert.equal(p.layers[p.layers.length - 1].name, 'Socket');
  // middle of the 20 × 10 box at (200, 100)
  assert.deepEqual([res.bounds.minX, res.bounds.minY, res.bounds.maxX, res.bounds.maxY], [190, 95, 210, 105]);
  const hole = s.entities.find(e => e instanceof Circle);
  assert.deepEqual([hole.center.x, hole.center.y, hole.r], [200, 100, 2]);
  const ids = allIds(p);
  assert.equal(new Set(ids).size, ids.length, 'every id is unique');
  // everything inserted sits on the part's layer
  const lid = res.layerIds[0];
  assert.ok(s.entities.filter(e => res.entityIds.includes(e.id)).every(e => e.layerId === lid));
  assert.ok(s.fills.at(-1).layerId === lid && s.strokes.at(-1).layerId === lid);
  assert.deepEqual(s.fills.at(-1).seed, { x: 193, y: 98 });
  assert.equal(s.strokes.at(-1).text, 'p1', 'text that looks like an id is left alone');
  assert.deepEqual([s.strokes.at(-1).points[0].x, s.strokes.at(-1).points[0].y], [192, 103]);
});

test('the part is not pinned, keeps its relations, and its names never collide', () => {
  const p = host();
  const res = insertProject(p, part(), { at: { x: 200, y: 100 } });
  const s = p.active();
  assert.equal(res.pinsDropped, 1);
  assert.ok(!s.constraints.some(c => c.kind === 'fix'));
  const dims = s.constraints.filter(c => c.kind === 'distance');
  assert.deepEqual(dims.map(c => c.name), ['D1', 'D2']);
  assert.equal(dims[1].expr, 'w_2', 'the part\'s formula follows its renamed variable');
  assert.deepEqual(p.variables, [{ name: 'w', expr: '100' }, { name: 'w_2', expr: '20' }]);
  // relations point at the new ids and the whole solves where it was put
  const live = new Set(allIds(p));
  for (const c of s.constraints) for (const r of c.refs()) assert.ok(live.has(r), `relation ${c.kind} refers to a live id`);
  const r = new Solver().solve(s, [s], [], { diagnostics: true });
  assert.ok(r.converged !== false);
  const hole = s.entities.find(e => e instanceof Circle);
  assert.ok(Math.abs(hole.center.x - 200) < 1e-6 && Math.abs(hole.center.y - 100) < 1e-6);
});

test('inserting twice gives two independent parts; the saved form round-trips', () => {
  const p = host();
  const a = insertProject(p, part(), { at: { x: 0, y: 50 } });
  const b = insertProject(p, part(), { at: { x: 60, y: 50 } });
  assert.equal(new Set([...a.entityIds, ...b.entityIds]).size, 10);
  assert.deepEqual(p.active().constraints.filter(c => c.kind === 'distance').map(c => c.name), ['D1', 'D2', 'D3']);
  assert.equal(p.variables.length, 2, 'the same variable is shared by both copies');
  const j = JSON.stringify(p.toJSON());
  assert.equal(JSON.stringify(Project.fromJSON(JSON.parse(j)).toJSON()), j);
});

test('nothing to insert gives null and leaves the drawing alone', () => {
  const p = host();
  const empty = new Project(); empty.addSketch('E');
  const j = JSON.stringify(p.toJSON());
  assert.equal(insertProject(p, empty.toJSON(), { at: { x: 0, y: 0 } }), null);
  assert.equal(JSON.stringify(p.toJSON()), j);
});

test('a real example inserts whole (desk: relations, dimensions, fills)', () => {
  const desk = JSON.parse(readFileSync(new URL('../../app/examples/desk.json', import.meta.url)));
  const p = host();
  const n0 = p.active().constraints.length;
  const res = insertProject(p, desk, { at: { x: 0, y: 0 } });
  assert.ok(res.entityIds.length > 5 && p.active().constraints.length > n0 + 5);
  const ids = allIds(p);
  assert.equal(new Set(ids).size, ids.length);
  const names = p.active().constraints.map(c => c.name).filter(Boolean);
  assert.equal(new Set(names).size, names.length, 'dimension names are unique');
});

test('a part with a linked pattern keeps its pattern, with every reference renewed', async () => {
  const { PatternConstraint, defaultPatternParams, syncPattern } = await import('../../app/src/core/patterns.js');
  const src = new Project(); src.name = 'Header'; const s0 = src.addSketch('S');
  const pad = new Circle(new Point(0, 0), 0.5); s0.addEntity(pad);
  const centre = new Point(0, -5); s0.addEntity(centre);
  const p = defaultPatternParams('linear'); p.d1.count = 4; p.d1.spacing = 2.54;
  const pat = new PatternConstraint('linear', p, [pad.id]); syncPattern(s0, pat); s0.constraints.push(pat);
  const circ = defaultPatternParams('circular'); circ.center = { x: 3, y: 4 };       // a fixed spot, not a point
  const pat2 = new PatternConstraint('circular', circ, [pad.id]); syncPattern(s0, pat2); s0.constraints.push(pat2);
  const saved = JSON.parse(JSON.stringify(src.toJSON()));
  const srcMid = (() => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const e of s0.entities) { const q = e.center || e; const r = e.r || 0; a = Math.min(a, q.x - r); b = Math.max(b, q.x + r); c = Math.min(c, q.y - r); d = Math.max(d, q.y + r); } return { x: (a + b) / 2, y: (c + d) / 2 }; })();

  const host0 = host();
  const res = insertProject(host0, saved, { at: { x: 100, y: 50 } });
  const s = host0.active();
  const pats = s.constraints.filter(c => c.kind === 'pattern');
  assert.equal(pats.length, 2);
  const live = new Set(allIds(host0));
  for (const c of pats) for (const r of c.refs()) assert.ok(live.has(r), 'pattern refers to live ids');
  const circles = s.entities.filter(e => e instanceof Circle && res.entityIds.includes(e.id));
  assert.equal(circles.length, s0.entities.filter(e => e instanceof Circle).length);
  // the row keeps its 2.54 pitch after solving, where it was put
  const r = new Solver().solve(s, [s], [], { diagnostics: true });
  assert.ok(r.ok !== false);
  const row = circles.filter(c => Math.abs(c.center.y - circles[0].center.y) < 1e-6).map(c => c.center.x).sort((a, b) => a - b);
  assert.ok(row.length >= 4 && Math.abs((row[1] - row[0]) - 2.54) < 1e-6);
  // the fixed centre of the circular pattern moved with the part
  const dx = 100 - srcMid.x, dy = 50 - srcMid.y;
  const moved = pats.find(c => c.type === 'circular').params.center;
  assert.ok(Math.abs(moved.x - (3 + dx)) < 1e-6 && Math.abs(moved.y - (4 + dy)) < 1e-6, 'a fixed spot inside a pattern moves with the part');
  const j = JSON.stringify(host0.toJSON());
  assert.equal(JSON.stringify(Project.fromJSON(JSON.parse(j)).toJSON()), j);
});

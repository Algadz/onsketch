import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../app/src/core/model.js';
import { inkBounds, inkHit, inkInBox, reviveStroke, strokeToJSON, textBounds } from '../../app/src/core/strokes.js';
import { anchorLookup, groupItems, linkItems, rebaseLinks, syncLinks, ungroupItems, unlinkItems, withGroups } from '../../app/src/core/ink-links.js';
import { circle, line, near, point, sketch } from './helpers.js';

const stroke = (pts, extra = {}) => ({
  id: 'k' + Math.random().toString(36).slice(2, 7), layerId: 'l', kind: 'pen', color: '#111418', opacity: 1, width: 1,
  points: pts.map(([x, y]) => ({ x, y })), ...extra,
});
const text = (x, y, t = 'Hello', extra = {}) => ({
  id: 'k' + Math.random().toString(36).slice(2, 7), layerId: 'l', kind: 'text', color: '#111418', opacity: 1,
  size: 4, text: t, points: [{ x, y }], ...extra,
});
const sync = (s, skip) => syncLinks(s.strokes, anchorLookup([s]), skip);

test('texts round-trip with size, bold, box, group and link', () => {
  const p = new Project(); const s = p.addSketch('S');
  const l = line(s, 0, 0, 10, 0);
  const t = text(1, 5, 'Kitchen\n12 m²', { layerId: p.layers[0].id, bold: true, box: { color: 'paper', border: true }, group: 'g7' });
  s.strokes.push(t);
  linkItems([t], l);
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const b = back.active().strokes[0];
  assert.equal(b.kind, 'text');
  assert.equal(b.text, 'Kitchen\n12 m²');
  assert.equal(b.size, 4);
  assert.equal(b.bold, true);
  assert.deepEqual(b.box, { color: 'paper', border: true });
  assert.equal(b.group, 'g7');
  assert.equal(b.link.to, l.id);
  assert.deepEqual(b.link.f, t.link.f);
});

test('empty texts and bad boxes are cleaned on load', () => {
  assert.equal(reviveStroke({ kind: 'text', text: '   ', pts: [0, 0] }), null);
  const t = reviveStroke({ kind: 'text', text: 'A', size: -1, pts: [0, 0, 5, 5], box: { color: 'red' } });
  assert.equal(t.size, 5);
  assert.deepEqual(t.points, [{ x: 0, y: 0 }]);
  assert.deepEqual(t.box, { color: 'paper' });
  assert.equal(reviveStroke({ kind: 'pen', pts: [0, 0], link: { to: 'e1', f: [0, 0, 1, 0, 0] } }).link, undefined);
  assert.equal(strokeToJSON(reviveStroke({ kind: 'text', text: 'A', pts: [0, 0] })).box, undefined);
});

test('a text box grows the bounds and the hit area by its padding', () => {
  const t = text(0, 0, 'AB');
  const plain = inkBounds(t);
  const boxed = inkBounds({ ...t, box: { color: 'paper' } });
  assert.deepEqual(textBounds(t), plain);
  assert.ok(near(boxed.minX, plain.minX - 1.4) && near(boxed.maxY, plain.maxY + 1.4));
  assert.ok(near(plain.maxY - plain.minY, 5));                 // one line: 1.25 × size
  assert.ok(inkHit(t, { x: 0.5, y: -1 }, 0));
  assert.ok(!inkHit(t, { x: -0.5, y: 0.5 }, 0));
  assert.ok(inkHit({ ...t, box: { color: 'paper' } }, { x: -0.5, y: 0.5 }, 0));
  assert.ok(inkInBox(t, -1, -6, 20, 1));
  assert.ok(!inkInBox(t, 1, -6, 20, 1));
});

test('ink linked to a point moves with it', () => {
  const s = sketch();
  const pt = point(s, 0, 0);
  const st = stroke([[1, 1], [2, 3]]);
  s.strokes.push(st);
  linkItems([st], pt);
  assert.equal(sync(s), false);                                // nothing moved yet
  pt.x = 5; pt.y = -2;
  assert.equal(sync(s), true);
  assert.deepEqual(st.points.map(p => [p.x, p.y]), [[6, -1], [7, 1]]);
});

test('ink linked to a line slides with its spot and turns with it', () => {
  const s = sketch();
  const l = line(s, 0, 0, 10, 0);
  const st = stroke([[5, 1], [5, 2]]);                         // a tick above the middle
  s.strokes.push(st);
  linkItems([st], l);
  assert.ok(near(st.link.t, 0.5));
  l.p2.x = 20;                                                 // longer: middle moves to x = 10
  sync(s);
  assert.ok(near(st.points[0].x, 10) && near(st.points[0].y, 1));
  l.p2.x = 0; l.p2.y = 20;                                     // turned 90° to vertical, length 20
  sync(s);
  assert.ok(near(st.points[0].x, -1) && near(st.points[0].y, 10));
  assert.ok(near(st.points[1].x, -2) && near(st.points[1].y, 10));
});

test('text linked to a line keeps its letters upright and its size', () => {
  const s = sketch();
  const l = line(s, 0, 0, 10, 0);
  const t = text(3, 6, 'Hi');
  s.strokes.push(t);
  linkItems([t], l);
  const before = textBounds(t);
  l.p1.y = 5; l.p2.y = 5;                                      // moved up by 5
  sync(s);
  const after = textBounds(t);
  assert.ok(near(after.minY - before.minY, 5) && near(after.minX, before.minX));
  assert.equal(t.size, 4);
});

test('ink linked to a circle scales its position with the radius', () => {
  const s = sketch();
  const c = circle(s, 0, 0, 10);
  const ring = stroke([[12, 0], [0, 12], [-12, 0]]);
  s.strokes.push(ring);
  linkItems([ring], c);
  c.r = 20; c.center.x = 100;
  sync(s);
  assert.deepEqual(ring.points.map(p => [Math.round(p.x), Math.round(p.y)]), [[124, 0], [100, 24], [76, 0]]);
});

test('deleting the anchor unlinks the ink and leaves it in place', () => {
  const s = sketch();
  const l = line(s, 0, 0, 10, 0);
  const st = stroke([[5, 1]]);
  s.strokes.push(st);
  linkItems([st], l.p2);                                       // a line end is a valid anchor
  s.removeEntity(l);
  assert.equal(sync(s), true);
  assert.equal(st.link, undefined);
  assert.deepEqual(st.points, [{ x: 5, y: 1 }]);
});

test('items being dragged are not pulled, and keep their link after a rebase', () => {
  const s = sketch();
  const pt = point(s, 0, 0);
  const st = stroke([[1, 0]]);
  s.strokes.push(st);
  linkItems([st], pt);
  // the user drags the point and the ink together by (+3, 0)
  pt.x = 3; st.points = [{ x: 4, y: 0 }];
  assert.equal(sync(s, new Set([st])), false);
  rebaseLinks([st], anchorLookup([s]));
  assert.equal(sync(s), false);                                // no double move
  assert.deepEqual(st.points, [{ x: 4, y: 0 }]);
  pt.x = 10;
  sync(s);
  assert.deepEqual(st.points, [{ x: 11, y: 0 }]);
});

test('linked ink survives an undo round-trip without creeping', () => {
  const p = new Project(); const s = p.addSketch('S');
  const l = line(s, 0.1234567, 0, 10.7654321, 3.3333333);
  const st = stroke([[5, 5], [6, 7]], { layerId: p.layers[0].id });
  s.strokes.push(st);
  linkItems([st], l);
  const back = Project.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  const bs = back.active();
  const before = bs.strokes[0].points.map(q => ({ ...q }));
  syncLinks(bs.strokes, anchorLookup([bs]));
  assert.deepEqual(bs.strokes[0].points, before);
});

test('groups: select together, group links follow one anchor, ungroup', () => {
  const s = sketch();
  const pt = point(s, 0, 0);
  const a = stroke([[1, 1]]), b = text(2, 2), c = stroke([[9, 9]]);
  s.strokes.push(a, b, c);
  linkItems([a], pt);
  groupItems([a, b], 'g1', anchorLookup([s]));
  assert.equal(b.link?.to, pt.id);                             // the unlinked member joins the link
  assert.deepEqual(withGroups(s.strokes, [b]), [a, b]);
  assert.deepEqual(withGroups(s.strokes, [c]), [c]);
  pt.x = 1;
  sync(s);
  assert.ok(near(a.points[0].x, 2) && near(b.points[0].x, 3));
  assert.equal(ungroupItems([a, b]), 2);
  assert.equal(unlinkItems([a, b]), 2);
  assert.equal(a.group, undefined);
});

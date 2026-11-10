import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../app/src/core/model.js';
import { inkBounds, inkHit, reviveStroke, strokeToJSON } from '../../app/src/core/strokes.js';
import { anchorLookup, linkItems, syncLinks } from '../../app/src/core/ink-links.js';
import { attachFromSnap, constrainAngle, detachMovedEnds, headedEnds, setArrowEnd, syncArrowEnds } from '../../app/src/core/arrows.js';
import { SnapEngine } from '../../app/src/editor/snap.js';
import { circle, line, near, point, sketch } from './helpers.js';

const arrow = (x0, y0, x1, y1, extra = {}) => ({
  id: 'k' + Math.random().toString(36).slice(2, 7), layerId: 'l', kind: 'arrow', color: '#111418', opacity: 1, width: 1,
  points: [{ x: x0, y: y0 }, { x: x1, y: y1 }], ...extra,
});
const view = { zoom: 1 };
const snapAt = (s, x, y) => new SnapEngine().find({ x, y }, view, [s]);
const sync = (s) => syncArrowEnds(s.strokes, anchorLookup([s]));

test('arrows round-trip with tips, head, dash and attached ends', () => {
  const p = new Project(); const s = p.addSketch('S');
  const c = circle(s, 50, 0, 10);
  const a = arrow(0, 0, 40, 0, { layerId: p.layers[0].id, tips: 'both', head: 'open', dash: true });
  setArrowEnd(a, 1, { to: c.id, a: Math.PI });
  s.strokes.push(a);
  const json = JSON.parse(JSON.stringify(p.toJSON()));
  const saved = json.sketches[0].strokes[0];
  assert.deepEqual([saved.tips, saved.head, saved.dash], ['both', 'open', true]);
  assert.deepEqual(saved.at, [null, { to: c.id, a: Math.PI }]);
  const b = Project.fromJSON(json).active().strokes[0];
  assert.equal(b.kind, 'arrow');
  assert.deepEqual(headedEnds(b), [true, true]);
  assert.deepEqual(b.at, [null, { to: c.id, a: Math.PI }]);
  assert.deepEqual(b.points, a.points);
});

test('defaults are not saved, odd values are cleaned', () => {
  const o = strokeToJSON(arrow(0, 0, 1, 1));
  assert.equal(o.tips, undefined); assert.equal(o.head, undefined); assert.equal(o.at, undefined);
  const r = reviveStroke({ kind: 'arrow', pts: [0, 0, 1, 1, 5, 5], tips: 'sideways', head: 'star', at: [{ to: '' }, { to: 'e1', t: 3 }] });
  assert.deepEqual(r.points, [{ x: 0, y: 0 }, { x: 5, y: 5 }]);   // tail and tip only
  assert.equal(r.tips, undefined); assert.equal(r.head, undefined);
  assert.deepEqual(r.at, [null, { to: 'e1', t: 1 }]);
  assert.equal(reviveStroke({ kind: 'arrow', pts: [0, 0] }), null);
  assert.deepEqual(headedEnds({ tips: 'none' }), [false, false]);
});

test('the head counts for hits and bounds', () => {
  const a = arrow(0, 0, 10, 0, { width: 1 });
  assert.ok(inkHit(a, { x: 10, y: 1.5 }, 0));                    // inside the head's half-width
  assert.ok(!inkHit(a, { x: 5, y: 3 }, 0));
  assert.ok(near(inkBounds(a).maxY, 1.8));
});

test('snaps become attachments: point, line fraction, circle angle, centre', () => {
  const s = sketch();
  const l = line(s, 0, 0, 100, 0);
  const c = circle(s, 200, 0, 20);
  assert.deepEqual(attachFromSnap(snapAt(s, 1, 1)), { to: l.p1.id });
  const on = attachFromSnap(snapAt(s, 30, 2));
  assert.equal(on.to, l.id); assert.ok(near(on.t, 0.3));
  assert.deepEqual(attachFromSnap(snapAt(s, 50, 1)), { to: l.id, t: 0.5 });          // midpoint
  assert.deepEqual(attachFromSnap(snapAt(s, 201, 1)), { to: c.center.id });          // centre
  const rim = attachFromSnap(snapAt(s, 200 + 14.5, 14.5));
  assert.equal(rim.to, c.id); assert.ok(near(rim.a, Math.PI / 4));
  assert.equal(attachFromSnap(null), null);
});

test('attached ends follow their shapes; the arrow stretches', () => {
  const s = sketch();
  const l = line(s, 0, 0, 100, 0);
  const c = circle(s, 200, 0, 20);
  const a = arrow(50, 50, 180, 0);
  s.strokes.push(a);
  setArrowEnd(a, 0, { to: l.id, t: 0.5 });
  setArrowEnd(a, 1, { to: c.id, a: Math.PI });
  assert.equal(sync(s), true);                                    // tail moves onto the line
  assert.deepEqual(a.points[0], { x: 50, y: 0 });
  c.center.x = 300; c.r = 30;
  l.p2.x = 40;
  sync(s);
  assert.ok(near(a.points[1].x, 270) && near(a.points[1].y, 0));
  assert.ok(near(a.points[0].x, 20));
  assert.equal(sync(s), false);
});

test('deleting the shape detaches the end and leaves it in place', () => {
  const s = sketch();
  const p = point(s, 10, 10);
  const a = arrow(0, 0, 10, 10);
  s.strokes.push(a);
  setArrowEnd(a, 1, { to: p.id });
  s.removeEntity(p);
  assert.equal(sync(s), true);
  assert.equal(a.at, undefined);
  assert.deepEqual(a.points[1], { x: 10, y: 10 });
});

test('dragging an arrow away detaches it; dragging it with its shape keeps it', () => {
  const s = sketch();
  const p = point(s, 10, 0);
  const a = arrow(0, 0, 10, 0), b = arrow(0, 5, 10, 0);
  s.strokes.push(a, b);
  setArrowEnd(a, 1, { to: p.id });
  setArrowEnd(b, 1, { to: p.id });
  a.points = a.points.map(q => ({ x: q.x + 5, y: q.y }));          // a dragged alone
  p.x += 3;                                                        // b dragged with the point
  b.points = b.points.map(q => ({ x: q.x + 3, y: q.y }));
  detachMovedEnds([a, b], anchorLookup([s]));
  assert.equal(a.at, undefined);
  assert.deepEqual(b.at, [null, { to: p.id }]);
});

test('a linked arrow moves rigidly, then its attached end snaps back on', () => {
  const s = sketch();
  const p = point(s, 0, 0), q = point(s, 100, 0);
  const a = arrow(0, 10, 100, 0);
  s.strokes.push(a);
  linkItems([a], p);                     // the whole arrow follows p…
  setArrowEnd(a, 1, { to: q.id });       // …and its tip stays on q
  p.x = 20;
  const lookup = anchorLookup([s]);
  syncLinks(s.strokes, lookup);
  syncArrowEnds(s.strokes, lookup);
  assert.deepEqual(a.points, [{ x: 20, y: 10 }, { x: 100, y: 0 }]);
});

test('Shift constrains to 15° steps', () => {
  const r = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 1 });
  assert.ok(near(r.y, 0) && near(r.x, Math.hypot(10, 1)));
  const d = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 9 });
  assert.ok(near(Math.atan2(d.y, d.x), Math.PI / 4));
});

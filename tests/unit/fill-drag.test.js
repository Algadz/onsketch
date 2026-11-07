// Fill colours while geometry is dragged (Live Paint behaviour).
// Drag-like edge cases for fill colours. Each case: build shapes, paint,
// then move geometry in small steps (like drag frames) and check colours
// at probe points every frame against the reference (drag start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point, Line, Circle, Arc } from '../../app/src/core/entities.js';
import { findFaceAt, reconcileRegions, referenceRegions, regionContains } from '../../app/src/core/regions.js';

let nid = 0; const mk = () => 'n' + (nid++);
const rect = (x, y, w, h) => {
  const p = [new Point(x, y), new Point(x + w, y), new Point(x + w, y + h), new Point(x, y + h)];
  return [0, 1, 2, 3].map(i => new Line(p[i], p[(i + 1) % 4]));
};
const paint = (ents, pt, color) => ({ id: color, layerId: 'L', color, opacity: 1, seed: pt, region: findFaceAt(ents, pt) });
const colourAt = (fills, pt) => fills.find(f => f.region && regionContains(f.region, pt))?.color ?? null;
const moveShape = (ents, dx, dy) => { const seen = new Set(); for (const e of ents) for (const c of e.children()) if (!seen.has(c)) { seen.add(c); c.x += dx; c.y += dy; } };

function run(name, setup, frames, expect) {
  test('fill drag: ' + name, () => {
  const { ents, fills } = setup();
  const refs = referenceRegions(fills, ents);   // every area at drag start, painted or not
  const bad = [];
  frames.forEach((frame, i) => {
    frame(ents);
    const { fills: out } = reconcileRegions(refs, ents, mk);
    for (const [pt, want, note] of expect(i)) {
      const got = colourAt(out, pt);
      if (got !== want) bad.push(`frame ${i}: at (${pt.x},${pt.y}) ${note || ''} want ${want} got ${got}`);
    }
  });
  assert.deepEqual(bad, []);
  });
}
const steps = (n, f) => Array.from({ length: n }, (_, i) => (ents) => f(ents, i));

// 1. Move a filled circle far away (rigid translation).
run('move filled circle far away', () => {
  const c = new Circle(new Point(0, 0), 5); const ents = [c];
  return { ents, fills: [paint(ents, { x: 0, y: 0 }, 'red')] };
}, steps(10, (ents) => moveShape(ents, 4, 0)), (i) => [[{ x: 4 * (i + 1), y: 0 }, 'red', 'circle centre']]);

// 2. Move a filled rectangle rigidly far away.
run('move filled rectangle far away', () => {
  const ents = rect(0, 0, 10, 6);
  return { ents, fills: [paint(ents, { x: 5, y: 3 }, 'blue')] };
}, steps(8, (ents) => moveShape(ents, 3, 2)), (i) => [[{ x: 5 + 3 * (i + 1), y: 3 + 2 * (i + 1) }, 'blue', 'rect centre']]);

// 3. Grow / shrink a filled circle.
run('resize filled circle', () => {
  const c = new Circle(new Point(0, 0), 5); const ents = [c];
  return { ents, fills: [paint(ents, { x: 0, y: 0 }, 'red')] };
}, [ (e) => e[0].r = 9, (e) => e[0].r = 2, (e) => e[0].r = 0.5, (e) => e[0].r = 12 ],
   (i) => [[{ x: 0, y: 0 }, 'red', 'centre'], [{ x: [8, 1.5, 0.4, 11][i], y: 0 }, 'red', 'near rim']]);

// 4. Filled rectangle with an unfilled circle hole; drag the circle out.
run('drag unfilled hole out of a filled rectangle', () => {
  const r = rect(0, 0, 20, 10); const c = new Circle(new Point(10, 5), 3); const ents = [...r, c];
  return { ents, fills: [paint(ents, { x: 2, y: 2 }, 'green')] };
}, steps(6, (ents) => moveShape([ents[4]], 3, 0)), (i) => {
  const cx = 10 + 3 * (i + 1);
  const out = [[{ x: 2, y: 2 }, 'green', 'rect corner']];
  if (cx + 3 < 20) out.push([{ x: cx, y: 5 }, null, 'inside the hole']);
  if (cx - 3 > 20) out.push([{ x: cx, y: 5 }, null, 'circle now outside']);
  if (cx - 3 > 20) out.push([{ x: 10, y: 5 }, 'green', 'where the hole was']);
  return out;
});

// 5. A filled circle inside a filled rectangle; drag it out entirely.
run('drag a filled circle out of a filled rectangle', () => {
  const r = rect(0, 0, 20, 10); const c = new Circle(new Point(10, 5), 3); const ents = [...r, c];
  return { ents, fills: [paint(ents, { x: 2, y: 2 }, 'green'), paint(ents, { x: 10, y: 5 }, 'red')] };
}, steps(6, (ents) => moveShape([ents[4]], 3, 0)), (i) => {
  const cx = 10 + 3 * (i + 1);
  const out = [[{ x: 2, y: 2 }, 'green', 'rect corner'], [{ x: cx - 1, y: 5 }, 'red', 'circle body']];
  if (cx - 3 > 20) out.push([{ x: 10, y: 5 }, 'green', 'where the circle was']);
  return out;
});

// 6. Triangle collapses flat, then reopens.
run('collapse a filled triangle and reopen it', () => {
  const a = new Point(0, 0), b = new Point(10, 0), c = new Point(5, 8);
  const ents = [new Line(a, b), new Line(b, c), new Line(c, a)];
  return { ents, fills: [paint(ents, { x: 5, y: 2 }, 'red')] };
}, [ (e) => e[1].p2.y = 2, (e) => e[1].p2.y = 0.0, (e) => e[1].p2.y = -4, (e) => e[1].p2.y = 8 ],
   (i) => [[{ x: 5, y: [0.5, null, -1, 2][i] ?? 0 }, [ 'red', null, 'red', 'red' ][i], ['flatter', 'flat', 'flipped below', 'back'][i]]].filter(x => x[0].y !== null && !(i === 1)));

// 7. Quad dragged into a bowtie (self-crossing) and back.
run('quad to bowtie and back', () => {
  const p = [new Point(0, 0), new Point(10, 0), new Point(10, 10), new Point(0, 10)];
  const ents = [0, 1, 2, 3].map(i => new Line(p[i], p[(i + 1) % 4]));
  return { ents, fills: [paint(ents, { x: 5, y: 5 }, 'red')] };
}, [ (e) => { e[1].p2.x = -2; e[1].p2.y = 10; }, (e) => { e[1].p2.x = 10; e[1].p2.y = 10; } ],
   (i) => i === 0 ? [[{ x: 5, y: 2 }, 'red', 'lower lobe'], [{ x: -0.5, y: 9.5 }, 'red', 'upper lobe'], [{ x: 1, y: 8 }, null, 'outside both lobes']] : [[{ x: 5, y: 5 }, 'red', 'restored']]);

// 8. Slot (lines + arcs) moved and stretched.
run('filled slot moved and stretched', () => {
  const t1 = new Point(0, 2), t2 = new Point(10, 2), b1 = new Point(10, -2), b2 = new Point(0, -2);
  const right = new Arc(new Point(10, 0), 2, -Math.PI / 2, Math.PI / 2);
  const left = new Arc(new Point(0, 0), 2, Math.PI / 2, 1.5 * Math.PI);
  const ents = [new Line(t1, t2), right, new Line(b1, b2), left];
  return { ents, fills: [paint(ents, { x: 5, y: 0 }, 'red')] };
}, [ (e) => moveShape(e, 30, 0), (e) => { e[0].p2.x += 10; e[2].p1.x += 10; e[1].center.x += 10; } ],
   (i) => i === 0 ? [[{ x: 35, y: 0 }, 'red', 'moved']] : [[{ x: 45, y: 0 }, 'red', 'stretched end']]);

// 9. Moving a filled circle across a filled rectangle.
run('filled circle crosses a filled rectangle', () => {
  const r = rect(0, 0, 20, 10); const c = new Circle(new Point(-10, 5), 3); const ents = [...r, c];
  return { ents, fills: [paint(ents, { x: 10, y: 5 }, 'green'), paint(ents, { x: -10, y: 5 }, 'red')] };
}, steps(12, (ents) => moveShape([ents[4]], 3, 0)), (i) => {
  const cx = -10 + 3 * (i + 1);
  const out = [];
  if (cx < -3 || cx > 23) out.push([{ x: cx, y: 5 }, 'red', 'circle clear of the rectangle']);
  out.push([{ x: 10, y: 9.5 }, 'green', 'rect top band']);
  return out;
});

// 10. A new closed area sharing an edge with a painted one stays empty.
run('new neighbour area sharing an edge stays empty', () => {
  const r = rect(0, 0, 10, 10);
  const n1 = new Line(new Point(10, 0), new Point(20, 0)), n2 = new Line(new Point(20, 0), new Point(20, 10)), n3 = new Line(new Point(20, 10), new Point(15, 10));
  const ents = [...r, n1, n2, n3];
  return { ents, fills: [paint(ents, { x: 5, y: 5 }, 'red')] };
}, [ (e) => { e[6].p2.x = 10; } ],
   () => [[{ x: 15, y: 5 }, null, 'new neighbour'], [{ x: 5, y: 5 }, 'red', 'original']]);

// 11. Open the shape, move the loose end around, close it again elsewhere.
run('open, wander, close again', () => {
  const a = new Point(0, 0), b = new Point(10, 0), c = new Point(10, 10), d = new Point(0, 10), d2 = new Point(0, 0);
  const ents = [new Line(a, b), new Line(b, c), new Line(c, d), new Line(d, d2)];
  return { ents, fills: [paint(ents, { x: 5, y: 5 }, 'red')] };
}, [ (e) => { e[3].p2.x = -5; e[3].p2.y = -5; }, (e) => { e[3].p2.x = 3; e[3].p2.y = 0; } ],
   (i) => i === 0 ? [[{ x: 5, y: 5 }, null, 'open']] : [[{ x: 5, y: 5 }, 'red', 'closed again (corner moved)']]);


// 12. Two filled rectangles sharing a side; drag the shared side.
run('drag the side two filled rectangles share', () => {
  const a = new Point(0, 0), b = new Point(10, 0), c = new Point(10, 10), d = new Point(0, 10), e = new Point(20, 0), f = new Point(20, 10);
  const ents = [new Line(a, b), new Line(b, c), new Line(c, d), new Line(d, a), new Line(b, e), new Line(e, f), new Line(f, c)];
  return { ents, fills: [paint(ents, { x: 5, y: 5 }, 'red'), paint(ents, { x: 15, y: 5 }, 'blue')] };
}, steps(6, (ents) => { ents[1].p1.x += 1.5; ents[1].p2.x += 1.5; }),
   (i) => { const x = 10 + 1.5 * (i + 1); return [[{ x: x - 1, y: 5 }, 'red', 'left of the shared side'], [{ x: x + 0.5, y: 5 }, 'blue', 'right of it']]; });

// 13. Rectangle split red/blue; the cut line is moved and rotated.
run('move and rotate the line between two colours', () => {
  const r = rect(0, 0, 20, 10); const cut = new Line(new Point(10, 0), new Point(10, 10));
  const ents = [...r, cut];
  return { ents, fills: [paint(ents, { x: 2, y: 5 }, 'red'), paint(ents, { x: 18, y: 5 }, 'blue')] };
}, [ (e) => { e[4].p1.x = 14; e[4].p2.x = 14; }, (e) => { e[4].p1.x = 4; e[4].p2.x = 16; }, (e) => { e[4].p1.x = 17; e[4].p2.x = 3; } ],
   (i) => [[{ x: 1, y: 5 }, 'red', 'left end'], [{ x: 19, y: 5 }, 'blue', 'right end']]);

// 14. A filled circle grows over another filled circle.
run('filled circle grows over another filled circle', () => {
  const big = new Circle(new Point(0, 0), 4), small = new Circle(new Point(10, 0), 2);
  const ents = [big, small];
  return { ents, fills: [paint(ents, { x: 0, y: 0 }, 'red'), paint(ents, { x: 10, y: 0 }, 'blue')] };
}, [ (e) => e[0].r = 9, (e) => e[0].r = 15 ],
   (i) => i === 0 ? [[{ x: 0, y: 0 }, 'red', 'big centre'], [{ x: 11.5, y: 0 }, 'blue', 'small outer part']]
                  : [[{ x: 0, y: 0 }, 'red', 'big centre'], [{ x: 10, y: 0 }, 'blue', 'small, now inside']]);

// 15. Two overlapping filled circles pulled apart.
run('overlapping filled circles pulled apart', () => {
  const A = new Circle(new Point(0, 0), 5), B = new Circle(new Point(6, 0), 5);
  const ents = [A, B];
  return { ents, fills: [paint(ents, { x: -3, y: 0 }, 'red'), paint(ents, { x: 9, y: 0 }, 'blue')] };
}, steps(6, (ents) => { ents[1].center.x += 3; }),
   (i) => [[{ x: -3, y: 0 }, 'red', 'A'], [{ x: 6 + 3 * (i + 1) + 3, y: 0 }, 'blue', 'B']]);

// 16. Drag a corner of a filled rectangle across the opposite side and back.
run('corner dragged across the opposite side and back', () => {
  const ents = rect(0, 0, 10, 10);
  return { ents, fills: [paint(ents, { x: 5, y: 5 }, 'red')] };
}, [ (e) => { e[1].p2.y = 4; }, (e) => { e[1].p2.y = -5; }, (e) => { e[1].p2.y = 10; } ],
   (i) => [[{ x: 3, y: 2 }, 'red', 'body'], ...(i === 2 ? [[{ x: 9, y: 9 }, 'red', 'restored corner']] : [])]);

// 15b. Both overlapping filled circles move far apart (no positional overlap left).
run('overlapping filled circles both moved far apart', () => {
  const A = new Circle(new Point(0, 0), 5), B = new Circle(new Point(6, 0), 5);
  const ents = [A, B];
  return { ents, fills: [paint(ents, { x: -3, y: 0 }, 'red'), paint(ents, { x: 9, y: 0 }, 'blue')] };
}, steps(6, (ents) => { ents[0].center.x -= 6; ents[1].center.x += 6; }),
   (i) => [[{ x: -6 * (i + 1), y: 0 }, 'red', 'A centre'], [{ x: 6 + 6 * (i + 1), y: 0 }, 'blue', 'B centre']]);

// 15c. Same, but the lens between them was painted too.
run('three-colour overlapping circles pulled apart', () => {
  const A = new Circle(new Point(0, 0), 5), B = new Circle(new Point(6, 0), 5);
  const ents = [A, B];
  return { ents, fills: [paint(ents, { x: -3, y: 0 }, 'red'), paint(ents, { x: 9, y: 0 }, 'blue'), paint(ents, { x: 3, y: 0 }, 'green')] };
}, steps(6, (ents) => { ents[0].center.x -= 6; ents[1].center.x += 6; }),
   (i) => [[{ x: -6 * (i + 1), y: 0 }, 'red', 'A centre'], [{ x: 6 + 6 * (i + 1), y: 0 }, 'blue', 'B centre']]);


/* ---- Paint whose area no longer exists is removed ---- */
test('fill drag: painted pieces of overlapping circles pulled apart: colours go with the circles', () => {
  const A = new Circle(new Point(0, 0), 5), B = new Circle(new Point(6, 0), 5);
  const ents = [A, B];
  const fills = [paint(ents, { x: -3, y: 0 }, 'red'), paint(ents, { x: 9, y: 0 }, 'blue'), paint(ents, { x: 3, y: 0 }, 'green')];
  const refs = referenceRegions(fills, ents);
  A.center.x -= 40; B.center.x += 40;
  const { fills: out, removed } = reconcileRegions(refs, ents, mk);
  assert.equal(removed, 1, 'the lens no longer exists');
  assert.deepEqual(out.map(f => f.color).sort(), ['blue', 'red']);
  assert.equal(colourAt(out, { x: -40, y: 0 }), 'red');
  assert.equal(colourAt(out, { x: 46, y: 0 }), 'blue');
});

test('fill drag: an opened area loses its paint; closing it again during the same drag restores it', () => {
  const a = new Point(0, 0), b = new Point(10, 0), c = new Point(5, 8), loose = new Point(1, 0);
  const ents = [new Line(a, b), new Line(b, c), new Line(c, loose)];
  const fills = [paint(ents, { x: 5, y: 2 }, 'red')];
  const refs = referenceRegions(fills, ents);          // drag start
  loose.x = -5; loose.y = 6;                           // pulled away: nothing closed
  const open = reconcileRegions(refs, ents, mk);
  assert.equal(open.fills.length, 0); assert.equal(open.removed, 1);
  loose.x = 2; loose.y = 0;                            // back onto the base, same drag
  const back = reconcileRegions(refs, ents, mk);
  assert.equal(colourAt(back.fills, { x: 5, y: 2 }), 'red');
});

test('fill drag: a circle dragged off the chord that split it keeps the larger piece colour', () => {
  const c = new Circle(new Point(0, 0), 10);
  const chord = new Line(new Point(6, -12), new Point(6, 12));
  const ents = [c, chord];
  const fills = [paint(ents, { x: -2, y: 0 }, 'blue'), paint(ents, { x: 8, y: 0 }, 'yellow')];
  const refs = referenceRegions(fills, ents);
  c.center.x = -40;
  const { fills: out } = reconcileRegions(refs, ents, mk);
  assert.deepEqual(out.map(f => f.color), ['blue']);
  assert.equal(colourAt(out, { x: -40, y: 0 }), 'blue');
});

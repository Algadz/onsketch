// Builds the example projects the editor can open with /app/?example=<slug>.
// Usage: node scripts/build-examples.mjs   (writes app/examples/*.json)
import { writeFile } from 'node:fs/promises';
import { Point, Line, Circle } from '../app/src/core/entities.js';
import { Project } from '../app/src/core/model.js';
import { Layer } from '../app/src/core/style.js';
import { HorizontalConstraint, VerticalConstraint, DistanceConstraint, RadiusConstraint, PointLineDistanceConstraint, FixConstraint } from '../app/src/core/constraints.js';
import { linkItems } from '../app/src/core/ink-links.js';

/** The desk from the landing page: every size is a dimension or an equation,
 *  the hole is fixed at the origin, so the sketch is fully defined. */
function desk() {
  const p = new Project();
  p.name = 'Desk concept';
  const s = p.addSketch('Sketch 1');
  const top = p.layers[0]; top.name = 'Desk';
  const notes = new Layer('Notes'); p.layers.push(notes);
  p.activeLayerId = top.id;
  const own = (x, l = top) => { x.layerId = l.id; return x; };
  const con = (c, name, expr) => { own(c); if (name) c.name = name; if (expr) c.expr = expr; s.constraints.push(c); return c; };
  const rect = (x0, y0, x1, y1) => {
    const a = new Point(x0, y0), b = new Point(x1, y0), c = new Point(x1, y1), d = new Point(x0, y1);
    const ls = [new Line(a, b), new Line(b, c), new Line(c, d), new Line(d, a)];
    for (const l of ls) { own(l); s.addEntity(l); }
    con(new HorizontalConstraint(ls[0].id, a.id, b.id)); con(new HorizontalConstraint(ls[2].id, c.id, d.id));
    con(new VerticalConstraint(ls[1].id, b.id, c.id));   con(new VerticalConstraint(ls[3].id, d.id, a.id));
    return { a, b, c, d };
  };
  const W = 1400, D = W / 2, BACK = 150, HOLE = 100;
  const top_y = BACK, front = BACK - D;
  const k = rect(-W / 2, front, W / 2, top_y);
  const MW = W / 2, MD = D * 0.4, MF = 60;
  const m = rect(-MW / 2, front + MF, MW / 2, front + MF + MD);

  const hole = own(new Circle(new Point(0, 0), HOLE / 2)); s.addEntity(hole);
  con(new FixConstraint(hole.center.id, 0, 0));

  con(new DistanceConstraint(k.a.id, k.b.id, W), 'D1');
  con(new DistanceConstraint(k.b.id, k.c.id, D), 'D2', 'D1 / 2');
  const dia = con(new RadiusConstraint(hole.id, HOLE / 2), 'D3'); dia.isDiameter = true;
  con(new PointLineDistanceConstraint(hole.center.id, { a: k.c.id, b: k.d.id }, BACK), 'D4');
  con(new PointLineDistanceConstraint(hole.center.id, { a: k.d.id, b: k.a.id }, W / 2), 'D5', 'D1 / 2');
  con(new DistanceConstraint(m.a.id, m.b.id, MW), 'D6', 'D1 / 2');
  con(new DistanceConstraint(m.b.id, m.c.id, MD), 'D7', 'D2 * 0.4');
  con(new PointLineDistanceConstraint(m.a.id, { a: k.a.id, b: k.b.id }, MF), 'D8');
  con(new PointLineDistanceConstraint(m.a.id, { a: k.d.id, b: k.a.id }, (W - MW) / 2), 'D9', 'D1 / 4');

  s.fills.push({ id: 'f1', layerId: top.id, color: '#c8955f', opacity: 0.85, seed: { x: -W / 2 + 40, y: front + 20 } });
  s.fills.push({ id: 'f2', layerId: top.id, color: '#47698f', opacity: 0.9, seed: { x: 0, y: front + MF + 20 } });

  // Ink on its own layer: a red circle around the hole, an arrow, a highlight.
  const pts = (arr) => arr.map(([x, y]) => ({ x, y }));
  const circle = [];
  for (let i = 0; i <= 44; i++) {
    const t = i / 40 * Math.PI * 2 + 0.6, r = 105 + 9 * Math.sin(i * 1.7);
    circle.push([r * 1.15 * Math.cos(t), r * Math.sin(t)]);
  }
  s.strokes.push({ id: 'k1', layerId: notes.id, kind: 'pen', color: '#d63a3a', opacity: 1, width: 9, points: pts(circle) });
  s.strokes.push({ id: 'k2', layerId: notes.id, kind: 'pen', color: '#d63a3a', opacity: 1, width: 9, points: pts([[460, 330], [330, 230], [200, 125], [140, 80]]) });
  s.strokes.push({ id: 'k3', layerId: notes.id, kind: 'pen', color: '#d63a3a', opacity: 1, width: 9, points: pts([[205, 85], [140, 80], [158, 140]]) });
  s.strokes.push({ id: 'k4', layerId: notes.id, kind: 'marker', color: '#c9a400', opacity: 0.45, width: 70, points: pts([[-300, 110], [300, 110]]) });
  return p;
}


/** A four-bar linkage: the example offered by the welcome tour.
 *  Every length is locked, one degree of freedom is left on purpose:
 *  drag the crank and the whole mechanism follows, its notes too.
 *    A fixed, D on the horizontal through A (ground), crank AB,
 *    coupler BC carrying the triangle BCE, rocker CD. 30 + 100 ≤ 90 + 70,
 *    so the crank turns all the way round (Grashof crank-rocker). */
function linkage() {
  const p = new Project();
  p.name = 'Linkage';
  const s = p.addSketch('Sketch 1');
  const bars = p.layers[0]; bars.name = 'Linkage';
  const notes = new Layer('Notes'); p.layers.push(notes);
  p.activeLayerId = bars.id;
  const own = (x, l = bars) => { x.layerId = l.id; return x; };
  const add = (e) => { own(e); s.addEntity(e); return e; };
  const con = (c, name, expr) => { own(c); if (name) c.name = name; if (expr) c.expr = expr; s.constraints.push(c); return c; };
  const meet = (P, r1, Q, r2, up = 1) => {            // circle–circle intersection, upper (or lower) one
    const dx = Q.x - P.x, dy = Q.y - P.y, d = Math.hypot(dx, dy);
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
    const mx = P.x + a * dx / d, my = P.y + a * dy / d;
    return new Point(mx - up * h * dy / d, my + up * h * dx / d);
  };

  const CRANK = 30, COUPLER = 90, ROCKER = 70, GROUND = 100, BE = 60, CE = 50;
  const A = new Point(0, 0), D = new Point(GROUND, 0);
  const B = new Point(CRANK * Math.cos(Math.PI / 3), CRANK * Math.sin(Math.PI / 3));
  const C = meet(B, COUPLER, D, ROCKER);
  const E = meet(B, BE, C, CE);

  const ground = add(new Line(A, D));
  add(new Line(A, B));                                 // the crank
  const coupler = add(new Line(B, C));
  const rocker = add(new Line(C, D));
  add(new Line(C, E)); add(new Line(E, B));
  // The crank's path, a construction circle sized by the crank's dimension.
  const path = add(new Circle(new Point(0, 0), CRANK)); path.construction = true;
  con(new FixConstraint(path.center.id, 0, 0));

  con(new FixConstraint(A.id, 0, 0));
  con(new HorizontalConstraint(ground.id, A.id, D.id));
  con(new DistanceConstraint(A.id, B.id, CRANK), 'D1');
  con(new DistanceConstraint(B.id, C.id, COUPLER), 'D2');
  con(new DistanceConstraint(C.id, D.id, ROCKER), 'D3');
  con(new DistanceConstraint(A.id, D.id, GROUND), 'D4').labelOffset = -16;   // below the ground marks
  con(new DistanceConstraint(B.id, E.id, BE), 'D5', 'D2 * 2 / 3');
  con(new DistanceConstraint(C.id, E.id, CE), 'D6');
  con(new RadiusConstraint(path.id, CRANK), 'D7', 'D1');

  s.fills.push({ id: 'f1', layerId: bars.id, color: '#f5a524', opacity: 0.8,
    seed: { x: (B.x + C.x + E.x) / 3, y: (B.y + C.y + E.y) / 3 } });

  // Ink: ground marks, the path of E, and notes that ride on the bars.
  const ink = [];
  const pen = (pts, color = '#58616d', width = 0.8, kind = 'pen', opacity = 1) => {
    const k = { id: 'k' + (ink.length + 1), layerId: notes.id, kind, color, opacity, width, points: pts.map(([x, y]) => ({ x, y })) };
    ink.push(k); return k;
  };
  const text = (x, y, t, o = {}) => {
    const k = { id: 'k' + (ink.length + 1), layerId: notes.id, kind: 'text', color: o.color || '#1b2028', opacity: 1, size: o.size || 4, text: t, bold: !!o.bold, points: [{ x, y }] };
    if (o.box) k.box = o.box;
    ink.push(k); return k;
  };
  const arrow = (from, to, color = '#d63a3a') => {
    const k = { id: 'k' + (ink.length + 1), layerId: notes.id, kind: 'arrow', color, opacity: 1, width: 0.9, points: [{ x: from[0], y: from[1] }, { x: to[0], y: to[1] }] };
    ink.push(k); return k;
  };
  for (const gx of [0, GROUND]) {                     // ground hatching under A and D
    pen([[gx - 8, -4], [gx + 8, -4]], '#58616d', 0.9);
    for (let i = 0; i < 5; i++) pen([[gx - 7 + i * 4, -4], [gx - 10 + i * 4, -8]], '#58616d', 0.6);
  }
  // Path of E over a full turn of the crank, for these sizes.
  const trace = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120 * Math.PI * 2;
    const b = { x: CRANK * Math.cos(t), y: CRANK * Math.sin(t) };
    const c = meet(b, COUPLER, D, ROCKER), e = meet(b, BE, c, CE);
    trace.push([e.x, e.y]);
  }
  pen(trace, '#2563a5', 1.4, 'marker', 0.35);
  text(-46, 50, 'path of E', { color: '#2563a5', size: 3.6, bold: true });
  const eLabel = text(E.x - 3, E.y + 9, 'E', { color: '#2563a5', size: 4, bold: true });
  linkItems([eLabel], E);

  const drag = text(B.x - 44, B.y - 4, 'Drag me', { color: '#d63a3a', size: 4.5, bold: true });
  const dragArrow = arrow([B.x - 22, B.y - 8], [B.x - 3, B.y - 1]);
  linkItems([drag, dragArrow], B);                    // rides on B, stays upright
  const tri = text((B.x + C.x + E.x) / 3 - 8, (B.y + C.y + E.y) / 3 + 2, 'coupler', { size: 3.2 });
  linkItems([tri], coupler);
  text(-12, -34, 'Try: drag the crank round its circle · double-click 30 and type 40', { size: 3.4, box: { color: 'paper', border: true } });

  s.strokes.push(...ink);
  void rocker;
  return p;
}

const examples = { desk, linkage };
for (const [slug, make] of Object.entries(examples)) {
  const json = make().toJSON();
  await writeFile(new URL(`../app/examples/${slug}.json`, import.meta.url), JSON.stringify(json, null, 1) + '\n');
  console.log('wrote app/examples/' + slug + '.json');
}

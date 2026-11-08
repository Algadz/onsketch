// Builds the example projects the editor can open with /app/?example=<slug>.
// Usage: node scripts/build-examples.mjs   (writes app/examples/*.json)
import { writeFile } from 'node:fs/promises';
import { Point, Line, Circle } from '../app/src/core/entities.js';
import { Project } from '../app/src/core/model.js';
import { Layer } from '../app/src/core/style.js';
import { HorizontalConstraint, VerticalConstraint, DistanceConstraint, RadiusConstraint, PointLineDistanceConstraint, FixConstraint } from '../app/src/core/constraints.js';

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

const examples = { desk };
for (const [slug, make] of Object.entries(examples)) {
  const json = make().toJSON();
  await writeFile(new URL(`../app/examples/${slug}.json`, import.meta.url), JSON.stringify(json, null, 1) + '\n');
  console.log('wrote app/examples/' + slug + '.json');
}

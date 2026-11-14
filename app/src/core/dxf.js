import { Arc, Bezier, Circle, Line, Point } from './entities.js';
import { bezierSamples, sampleCount } from './bezier.js';

/* =============== DXF EXPORT ====================================
   The shapes of a project as an ASCII DXF (R12, the version every CAD,
   CAM and laser-cutter program reads), at real size in millimetres.

   Written: lines, circles, arcs and standalone points, each on a DXF
   layer named after its OnSketch layer. Construction geometry is left
   out unless asked for; it then goes on its own layer, CONSTRUCTION,
   so it can be hidden or kept from cutting. Hidden layers are skipped.
   Fills, ink, text, pictures and dimensions are not part of a DXF.
   ============================================================ */
const fmt = (n) => {
  const v = Math.abs(n) < 5e-7 ? 0 : n;
  return String(Math.round(v * 1e6) / 1e6);
};
const deg = (rad) => { let d = rad * 180 / Math.PI % 360; if (d < 0) d += 360; return d; };

/** A name every DXF reader accepts: A-Z, 0-9, _ and -, at most 31 long. */
export function dxfLayerName(name, used = new Set()) {
  let base = String(name || 'Layer').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'LAYER';
  if (base === '0') base = 'LAYER_0';
  let out = base, i = 2;
  while (used.has(out)) out = `${base}_${i++}`;
  used.add(out);
  return out;
}

/** @returns {{ text: string, count: number }} the file and how many shapes it holds */
/** $INSUNITS codes of the document units. */
const DXF_UNITS = { in: 1, ft: 2, mi: 3, mm: 4, cm: 5, m: 6, km: 7 };

export function toDXF(project, { construction = false } = {}) {
  const used = new Set(['CONSTRUCTION']);
  const names = new Map(project.layers.map(l => [l.id, dxfLayerName(l.name, used)]));
  const body = [];
  const seenLayers = new Set();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  const acc = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  const ent = (type, layer, pairs) => {
    seenLayers.add(layer);
    body.push('0', type, '8', layer);
    for (const [code, value] of pairs) body.push(String(code), typeof value === 'number' ? fmt(value) : String(value));
    count++;
  };
  for (const s of project.sketches) {
    if (s.visible === false) continue;
    for (const e of s.entities) {
      const layer = project.layerOf(e);
      if (layer && layer.visible === false) continue;
      if (e.construction && !construction) continue;
      const name = e.construction ? 'CONSTRUCTION' : (layer && names.get(layer.id)) || '0';
      if (e instanceof Line) {
        ent('LINE', name, [[10, e.p1.x], [20, e.p1.y], [30, 0], [11, e.p2.x], [21, e.p2.y], [31, 0]]);
        acc(e.p1.x, e.p1.y); acc(e.p2.x, e.p2.y);
      } else if (e instanceof Circle) {
        ent('CIRCLE', name, [[10, e.center.x], [20, e.center.y], [30, 0], [40, e.r]]);
        acc(e.center.x - e.r, e.center.y - e.r); acc(e.center.x + e.r, e.center.y + e.r);
      } else if (e instanceof Arc) {
        // DXF arcs always run counter-clockwise from start to end.
        const [a0, a1] = e.clockwise ? [e.a1, e.a0] : [e.a0, e.a1];
        ent('ARC', name, [[10, e.center.x], [20, e.center.y], [30, 0], [40, e.r], [50, deg(a0)], [51, deg(a1)]]);
        acc(e.center.x - e.r, e.center.y - e.r); acc(e.center.x + e.r, e.center.y + e.r);
      } else if (e instanceof Bezier) {
        // R12 has no splines: a polyline close enough to the curve (0.01 mm).
        const P = e.ctrl();
        const pts = bezierSamples(P, sampleCount(P, 0.01));
        seenLayers.add(name);
        body.push('0', 'POLYLINE', '8', name, '66', '1', '10', '0', '20', '0', '30', '0', '70', '0');
        for (const p of pts) { body.push('0', 'VERTEX', '8', name, '10', fmt(p.x), '20', fmt(p.y), '30', '0'); acc(p.x, p.y); }
        body.push('0', 'SEQEND', '8', name);
        count++;
      } else if (e instanceof Point) {
        ent('POINT', name, [[10, e.x], [20, e.y], [30, 0]]);
        acc(e.x, e.y);
      }
    }
  }
  if (!count) { minX = minY = maxX = maxY = 0; }
  const layers = [...seenLayers].filter(n => n !== '0');
  const out = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', String(DXF_UNITS[project.units] ?? 4),   // the document unit
    '9', '$EXTMIN', '10', fmt(minX), '20', fmt(minY), '30', '0',
    '9', '$EXTMAX', '10', fmt(maxX), '20', fmt(maxY), '30', '0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LTYPE', '70', '2',
    '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0',
    '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed', '72', '65', '73', '2', '40', '10', '49', '6', '49', '-4',
    '0', 'ENDTAB',
    '0', 'TABLE', '2', 'LAYER', '70', String(layers.length + 1),
    '0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS',
    ...layers.flatMap(n => ['0', 'LAYER', '2', n, '70', '0', '62', n === 'CONSTRUCTION' ? '6' : '7', '6', n === 'CONSTRUCTION' ? 'DASHED' : 'CONTINUOUS']),
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...body,
    '0', 'ENDSEC',
    '0', 'EOF',
  ];
  return { text: out.join('\r\n') + '\r\n', count };
}

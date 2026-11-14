import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Project } from '../../app/src/core/model.js';
import { Point, Line, Circle, Arc } from '../../app/src/core/entities.js';
import { Layer } from '../../app/src/core/style.js';
import { toDXF, dxfLayerName } from '../../app/src/core/dxf.js';
import { SvgContext, splitColor, parseFont } from '../../app/src/render/svg-context.js';

/** group code / value pairs of a DXF text */
const pairs = (text) => { const l = text.trim().split('\r\n'); const out = []; for (let i = 0; i < l.length; i += 2) out.push([l[i], l[i + 1]]); return out; };
const entities = (text) => {
  const p = pairs(text); const out = [];
  let i = p.findIndex(([c, v], k) => c === '2' && v === 'ENTITIES' && p[k - 1][1] === 'SECTION') + 1;
  for (; p[i][1] !== 'ENDSEC'; i++) { if (p[i][0] === '0') out.push({ type: p[i][1] }); else out.at(-1)[p[i][0]] = p[i][1]; }
  return out;
};

test('DXF: lines, circles, arcs and points at real size, on layers named after the drawing\'s', () => {
  const p = new Project(); const s = p.addSketch('S');
  p.layers[0].name = 'Découpe 1';
  const other = new Layer('holes & slots'); p.layers.push(other);
  s.addEntity(new Line(new Point(0, 0), new Point(120.5, 0)));
  const c = new Circle(new Point(10, 20), 4); s.addEntity(c); c.layerId = other.id;
  const a = new Arc(new Point(0, 0), 10, 0, Math.PI / 2); s.addEntity(a);
  const cw = new Arc(new Point(50, 0), 5, Math.PI, Math.PI / 2); cw.clockwise = true; s.addEntity(cw);
  s.addEntity(new Point(7, 8));
  const guide = new Line(new Point(0, 0), new Point(0, 50)); guide.construction = true; s.addEntity(guide);
  const { text, count } = toDXF(p);
  assert.equal(count, 5, 'construction geometry is left out');
  assert.ok(text.endsWith('0\r\nEOF\r\n'));
  const e = entities(text);
  assert.deepEqual(e.map(x => x.type), ['LINE', 'CIRCLE', 'ARC', 'ARC', 'POINT']);
  assert.deepEqual([e[0][10], e[0][20], e[0][11], e[0][21], e[0][8]], ['0', '0', '120.5', '0', 'DECOUPE_1']);
  assert.deepEqual([e[1][10], e[1][20], e[1][40], e[1][8]], ['10', '20', '4', 'HOLES_SLOTS']);
  assert.deepEqual([e[2][50], e[2][51]], ['0', '90']);
  assert.deepEqual([e[3][50], e[3][51]], ['90', '180'], 'a clockwise arc is written counter-clockwise');
  const head = pairs(text);
  const units = head.findIndex(([c, v]) => c === '9' && v === '$INSUNITS');
  assert.deepEqual(head[units + 1], ['70', '4'], 'millimetres');
  const withC = toDXF(p, { construction: true });
  assert.equal(withC.count, 6);
  assert.equal(entities(withC.text).at(-1)[8], 'CONSTRUCTION');
});

test('DXF: hidden layers are skipped; an empty drawing is still a valid file', () => {
  const p = new Project(); const s = p.addSketch('S');
  s.addEntity(new Line(new Point(0, 0), new Point(1, 1)));
  p.layers[0].visible = false;
  const { text, count } = toDXF(p);
  assert.equal(count, 0);
  assert.equal(entities(text).length, 0);
});

test('DXF layer names are legal and unique', () => {
  const used = new Set();
  assert.equal(dxfLayerName('Walls / 2nd floor', used), 'WALLS_2ND_FLOOR');
  assert.equal(dxfLayerName('walls   2nd floor', used), 'WALLS_2ND_FLOOR_2');
  assert.equal(dxfLayerName('0', used), 'LAYER_0');
  assert.equal(dxfLayerName('  ', used), 'LAYER');
  assert.ok(dxfLayerName('x'.repeat(80), used).length <= 31);
});

test('DXF: the desk example exports every solid shape', () => {
  const desk = Project.fromJSON(JSON.parse(readFileSync(new URL('../../app/examples/desk.json', import.meta.url))));
  const solid = desk.active().entities.filter(e => !e.construction).length;
  assert.equal(toDXF(desk).count, solid);
});

test('SVG context: paths are written transformed, curves as Béziers', () => {
  const c = new SvgContext(200, 100);
  c.translate(10, 20); c.scale(2, 2);
  c.beginPath(); c.moveTo(0, 0); c.lineTo(5, 0); c.closePath();
  c.strokeStyle = 'rgba(255, 0, 0, 0.5)'; c.lineWidth = 1.5; c.setLineDash([4, 2]); c.lineCap = 'round';
  c.stroke();
  assert.equal(c.out[0], '<path d="M10 20L20 20Z" fill="none" stroke="#ff0000" stroke-width="3" stroke-linecap="round" stroke-dasharray="8 4" opacity="0.5"/>');
  const d = new SvgContext(100, 100);
  d.beginPath(); d.arc(50, 50, 10, 0, Math.PI * 2); d.fillStyle = '#123456'; d.globalAlpha = 0.25; d.fill('evenodd');
  assert.match(d.out[0], /^<path d="M60 50C[^"]*" fill="#123456" fill-rule="evenodd" opacity="0\.25"\/>$/);
  assert.equal((d.out[0].match(/C/g) || []).length, 4, 'a full circle is four curves');
  assert.match(d.out[0], /60 50"/, 'and ends where it started');
});

test('SVG context: save / restore, text, pictures, document', () => {
  const c = new SvgContext(300, 150);
  c.save(); c.translate(5, 5); c.globalAlpha = 0.5; c.restore();
  c.font = '600 12px Inter, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#111';
  c.fillText('a < b & "c"', 30, 40);
  assert.equal(c.out[0], '<text xml:space="preserve" transform="matrix(1 0 0 1 0 0)" x="30" y="44.2" font-family="Inter, sans-serif" font-size="12" font-weight="600" text-anchor="middle" fill="#111">a &lt; b &amp; &quot;c&quot;</text>');
  c.drawImage({ src: 'data:image/png;base64,AAAA', naturalWidth: 4, naturalHeight: 2 }, 1, 2, 40, 20);
  assert.match(c.out[1], /^<image href="data:image\/png;base64,AAAA" x="1" y="2" width="40" height="20" preserveAspectRatio="none"/);
  c.beginPath(); c.moveTo(0, 0); c.arcTo(10, 0, 10, 10, 5); c.lineTo(10, 10); c.strokeStyle = '#000'; c.stroke();
  assert.match(c.out[2], /^<path d="M0 0L5 0C[^L]*10 5L10 10"/, 'arcTo rounds the corner');
  const svg = c.toSVG({ size: { width: '210mm', height: '297mm' }, title: 'A & B' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="210mm" height="297mm" viewBox="0 0 300 150"><title>A &amp; B<\/title>/);
  assert.ok(svg.endsWith('</svg>'));
});

test('colours and fonts are split the way SVG wants them', () => {
  assert.deepEqual(splitColor('rgba(17, 20, 24, 0.35)'), ['#111418', 0.35]);
  assert.deepEqual(splitColor('rgb(255,255,255)'), ['#ffffff', 1]);
  assert.deepEqual(splitColor('#1f7ad6'), ['#1f7ad6', 1]);
  assert.deepEqual(parseFont('italic 700 14.5px "Segoe UI", sans-serif'), { size: 14.5, family: '"Segoe UI", sans-serif', weight: '700', italic: true });
  assert.deepEqual(parseFont('11px ui-monospace'), { size: 11, family: 'ui-monospace', weight: null, italic: false });
});

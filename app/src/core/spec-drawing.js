// Sketch specs, the drawing side (see core/spec.js for the CAD side).
//
// What the Sketch window makes, from a spec: text, arrows, pen and marker
// strokes and ready-made shapes (sketch.strokes, core/strokes.js), fills
// of closed CAD areas (sketch.fills), layers, the canvas colour, and line
// type / weight on CAD shapes. The point of the drawing side is to tie it
// to the CAD geometry, as the editor does:
//   link   an item follows a point, line, circle or arc (core/ink-links.js):
//          a label stays on its part when a dimension changes
//   arrow  ends attached to a point, a spot along a line, or an angle on a
//          circle / arc (core/arrows.js): the arrow stretches with them
//   fill   colours the closed area of CAD shapes around a point; the colour
//          follows that area (core/regions.js)
// Items are placed after the CAD geometry is solved, so a point name
// means where that point ends up.
import { Arc, Bezier, Circle, Line, Point, newId } from './entities.js';
import { Layer, LINE_STYLES } from './style.js';
import { ARROW_HEADS, ARROW_TIPS, attachPoint } from './arrows.js';
import { SHAPE_FILLS, SHAPE_IDS } from './shapes.js';
import { BOX_PAD, PAPER, TEXT_MAX, placeTextCenter, textBox, textCenter } from './strokes.js';
import { anchorFrame, anchorLookup, linkItems } from './ink-links.js';
import { findFaceAt } from './regions.js';
import { IMAGES_TOTAL_MAX, imagePixelSize, imageSource, registerImage } from './images.js';
import { tracePointPath } from './trace.js';

export const DRAWING_TYPES = ['text', 'arrow', 'pen', 'marker', 'shape', 'image', 'trace'];
const IMAGE_DATA = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;
export const LINE_STYLE_IDS = Object.keys(LINE_STYLES);
export const DRAWING_LIMITS = { items: 2000, strokePoints: 5000, fills: 500, layers: 32 };

const DEG = Math.PI / 180;
const HEX = /^#[0-9a-f]{6}$/i;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/* =============== SPEC → PROJECT ================================ */

/** Reads layers, background, fills and drawing items (called by the
 *  Builder after the CAD shapes and constraints). `b` is the Builder. */
export function readPresentation(b, spec) {
  // Layers: names, bottom to top (or { name, visible, opacity }).
  b.layerNames = [];
  if (spec.layers != null) {
    if (!Array.isArray(spec.layers) || !spec.layers.length || spec.layers.length > DRAWING_LIMITS.layers) {
      b.bad(`layers: a list of 1 to ${DRAWING_LIMITS.layers} layer names, bottom to top.`);
    } else {
      spec.layers.forEach((l, i) => {
        const o = typeof l === 'string' ? { name: l } : l;
        const name = typeof o?.name === 'string' ? o.name.trim().slice(0, 40) : '';
        if (!name) { b.bad(`layers[${i}]: a name, or { "name", "visible", "opacity" }.`); return; }
        if (b.layerNames.some(x => x.name === name)) { b.bad(`layers[${i}]: "${name}" is listed twice.`); return; }
        const opacity = o.opacity == null ? 1 : Number(o.opacity);
        if (!(opacity > 0 && opacity <= 1)) b.bad(`layers[${i}]: "opacity" is between 0 and 1.`);
        b.layerNames.push({ name, visible: o.visible !== false, opacity });
      });
    }
  }
  b.layerOf = (name, where) => {
    if (name == null) return null;
    if (!b.layerNames.some(l => l.name === name)) {
      b.bad(`${where}: unknown layer "${name}"${b.layerNames.length ? ` (layers: ${b.layerNames.map(l => `"${l.name}"`).join(', ')})` : '; list it in "layers" first'}.`);
      return null;
    }
    return name;
  };
  // CAD shapes: layer, line type, weight (read in Builder.readShape).
  for (const s of b.shapes) {
    const look = s.look || {};
    if (look.layer != null) s.layer = b.layerOf(look.layer, s.where);
    if (look.line_style != null) {
      if (LINE_STYLE_IDS.includes(look.line_style)) s.lineStyle = look.line_style;
      else b.bad(`${s.where}: "line_style" is one of ${LINE_STYLE_IDS.join(', ')}.`);
    }
    if (look.weight != null) {
      if (Number.isFinite(look.weight) && look.weight > 0 && look.weight <= 20) s.lineWidth = look.weight;
      else b.bad(`${s.where}: "weight" is the line width in screen pixels, 0.5 to 20 (default 1.4).`);
    }
  }
  if (spec.background != null && !HEX.test(spec.background)) b.bad('background: a colour like "#f5f0e6".');
  b.background = HEX.test(spec.background ?? '') ? spec.background : null;

  const fills = spec.fills ?? [];
  if (!Array.isArray(fills) || fills.length > DRAWING_LIMITS.fills) b.bad(`fills: a list (at most ${DRAWING_LIMITS.fills}).`);
  else b.fills = fills.map((f, i) => readFill(b, f, `fills[${i}]`)).filter(Boolean);

  const items = spec.drawing ?? [];
  if (!Array.isArray(items) || items.length > DRAWING_LIMITS.items) b.bad(`drawing: a list (at most ${DRAWING_LIMITS.items} items).`);
  else b.items = items.map((it, i) => readItem(b, it, `drawing[${i}]` + (it && typeof it.type === 'string' ? ` (${it.type})` : ''))).filter(Boolean);
}

function color(b, v, where, fallback = '#111418') {
  if (v == null) return fallback;
  if (HEX.test(v)) return v.toLowerCase();
  b.bad(`${where}: "color" is a hex colour like "#1f7ad6".`);
  return fallback;
}
function opacity(b, v, where) {
  if (v == null) return 1;
  if (Number.isFinite(v) && v > 0 && v <= 1) return Math.max(0.02, v);
  b.bad(`${where}: "opacity" is between 0 and 1.`);
  return 1;
}
function positive(b, v, where, key) {
  if (v == null) return null;
  if (Number.isFinite(v) && v > 0) return v;
  b.bad(`${where}: "${key}" is a positive number (drawing units).`);
  return null;
}

/** A place for drawing: free coordinates, or a CAD point (by name). */
function place(b, v, where) {
  if (typeof v === 'string') {
    if (!b.names.has(v)) { b.bad(`${where}: unknown point "${v}".${b.hint(v)}`); return null; }
    const n = b.names.get(v);
    b.nodes[b.find(n)].uses.add('ref');               // a real point, so it can be followed
    return { node: n };
  }
  const c = b.coord(v, where);
  return c ? { xy: c } : null;
}

/** Arrow end: a place, or { "on": shape, "t" (lines, 0..1) | "angle" (circles / arcs, degrees) }. */
function arrowEnd(b, v, where) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v.on !== 'string') { b.bad(`${where}: { "on": shape id, "t": 0..1 } for a line, { "on": shape id, "angle": degrees } for a circle or arc.`); return null; }
    const s = b.shape(v.on, `${where}.on`, ['line', 'round']);
    if (!s) return null;
    if (s.type === 'line') {
      const t = v.t ?? 0.5;
      if (!(Number.isFinite(t) && t >= 0 && t <= 1)) { b.bad(`${where}: "t" is the fraction along the line, 0 to 1.`); return null; }
      return { shape: s, t };
    }
    if (!Number.isFinite(v.angle)) { b.bad(`${where}: "angle" (degrees, counter-clockwise from +x) for where on the ${s.type}.`); return null; }
    return { shape: s, a: v.angle * DEG };
  }
  return place(b, v, where);
}

/** What an item follows: a shape id, a point name, or { "to", "t" }. */
function linkRef(b, v, where) {
  if (v == null) return null;
  const to = typeof v === 'string' ? v : v?.to;
  const t = typeof v === 'object' && v ? v.t : undefined;
  if (typeof to !== 'string') { b.bad(`${where}: "link" is a shape id or a point name.`); return null; }
  if (b.shapeById.has(to) && !b.names.has(to)) {
    const s = b.shapeById.get(to);
    if (!['line', 'circle', 'arc'].includes(s.type)) { b.bad(`${where}: "link" can follow a line, circle, arc or point.`); return null; }
    if (t != null && !(s.type === 'line' && Number.isFinite(t) && t >= 0 && t <= 1)) { b.bad(`${where}: "t" (0..1) only applies to a line.`); return null; }
    return { shape: s, t };
  }
  if (b.names.has(to)) { const p = place(b, to, `${where}.link`); return p ? { node: p.node } : null; }
  b.shape(to, `${where}.link`);                          // its message names what is wrong
  return null;
}

function readFill(b, f, where) {
  if (!f || typeof f !== 'object') { b.bad(`${where}: { "at": [x, y], "color": "#…" }.`); return null; }
  const at = b.coord(f.at, `${where}.at`);
  if (!at) return null;
  return { where, at, color: color(b, f.color, where, '#1f7ad6'), opacity: f.opacity == null ? 0.35 : opacity(b, f.opacity, where), layer: b.layerOf(f.layer, where) };
}

function readItem(b, it, where) {
  if (!it || typeof it !== 'object') { b.bad(`${where}: a drawing item.`); return null; }
  const base = {
    where, type: it.type, color: color(b, it.color, where), opacity: opacity(b, it.opacity, where),
    layer: b.layerOf(it.layer, where), group: it.group == null ? null : String(it.group).slice(0, 40),
    link: linkRef(b, it.link, where),
  };
  switch (it.type) {
    case 'text': {
      const text = typeof it.text === 'string' ? it.text.slice(0, TEXT_MAX) : '';
      if (!text.trim()) { b.bad(`${where}: "text" can't be empty.`); return null; }
      const at = place(b, it.at, `${where}.at`);
      if (!at) return null;
      const align = it.align ?? 'center';
      if (!['center', 'left', 'right'].includes(align)) { b.bad(`${where}: "align" is "center" (default), "left" or "right".`); return null; }
      let box = null;
      if (it.box != null && it.box !== false) {
        if (it.box === true || it.box === PAPER) box = { color: PAPER };
        else if (HEX.test(it.box)) box = { color: it.box.toLowerCase() };
        else { b.bad(`${where}: "box" is true (the canvas colour) or a colour like "#fff3b0".`); return null; }
        if (it.border) box.border = true;
      }
      if (it.angle != null && !Number.isFinite(it.angle)) { b.bad(`${where}: "angle" in degrees.`); return null; }
      return { ...base, text, at, align, size: positive(b, it.size, where, 'size'), bold: !!it.bold, box, angle: (it.angle || 0) * DEG };
    }
    case 'arrow': {
      const from = arrowEnd(b, it.from, `${where}.from`), to = arrowEnd(b, it.to, `${where}.to`);
      if (!from || !to) return null;
      if (it.head != null && !ARROW_HEADS.includes(it.head)) { b.bad(`${where}: "head" is ${ARROW_HEADS.join(', ')}.`); return null; }
      if (it.tips != null && !ARROW_TIPS.includes(it.tips)) { b.bad(`${where}: "tips" is ${ARROW_TIPS.join(', ')} (which ends get a head).`); return null; }
      if (base.link) { b.bad(`${where}: arrows follow geometry through their ends ("from" / "to" on a point or { "on": … }), not "link".`); return null; }
      return { ...base, from, to, width: positive(b, it.width, where, 'width'), head: it.head, tips: it.tips, dash: !!it.dash };
    }
    case 'pen': case 'marker': {
      const pts = it.points;
      if (!Array.isArray(pts) || pts.length < 2 || pts.length > DRAWING_LIMITS.strokePoints) { b.bad(`${where}: "points" is a list of 2 to ${DRAWING_LIMITS.strokePoints} [x, y].`); return null; }
      const xy = pts.map((p, k) => b.coord(p, `${where}.points[${k}]`));
      if (xy.some(p => !p)) return null;
      return { ...base, points: xy, width: positive(b, it.width, where, 'width'), dash: !!it.dash };
    }
    case 'image': {
      const at = place(b, it.center, `${where}.center`);
      if (!at) return null;
      let image = null, src = null;
      if (typeof it.src === 'string' && it.src.startsWith('image:')) {
        image = it.src.slice(6);
        src = b.images?.[image] ?? imageSource(image);
        if (!src) { b.bad(`${where}: "${it.src}" isn't a picture of this sketch (pictures already in a sketch are "image:<id>" as get_sketch shows them).`); return null; }
      } else if (typeof it.src === 'string' && IMAGE_DATA.test(it.src)) src = it.src.replace(/\s+/g, '');
      else if (typeof it.src === 'string' && /^https?:/i.test(it.src)) { b.bad(`${where}: a picture from a link must be downloaded first (the OnSketch server does it for https links).`); return null; }
      else { b.bad(`${where}: "src" is an https link to a PNG, JPEG, WebP or GIF picture, a data URL of one, or "image:<id>" for a picture already in the sketch.`); return null; }
      b.imageBytes = (b.imageBytes || 0) + src.length;
      if (b.imageBytes > IMAGES_TOTAL_MAX) { b.bad(`${where}: pictures are too large together (${Math.round(IMAGES_TOTAL_MAX / 1e6)} MB at most in one sketch).`); return null; }
      const w = positive(b, it.width, where, 'width');
      if (!w) { b.bad(`${where}: "width" (drawing units); "height" follows the picture's proportions unless given.`); return null; }
      let h = positive(b, it.height, where, 'height');
      if (!h) { const px = imagePixelSize(src); h = px && px.w > 0 ? w * px.h / px.w : w; }
      if (it.angle != null && !Number.isFinite(it.angle)) { b.bad(`${where}: "angle" in degrees.`); return null; }
      return { ...base, src, image, at, w, h, angle: (it.angle || 0) * DEG };
    }
    case 'trace': {
      if (typeof it.point !== 'string') { b.bad(`${where}: "point" names the point whose path is drawn (it moves as the rest of the sketch allows).`); return null; }
      const p = place(b, it.point, `${where}.point`);
      if (!p) return null;
      if (base.link) { b.bad(`${where}: a traced path follows its point by itself; no "link".`); return null; }
      return { ...base, at: p, width: positive(b, it.width, where, 'width'), dash: it.dash !== false };
    }
    case 'shape': {
      if (!SHAPE_IDS.includes(it.shape)) { b.bad(`${where}: "shape" is one of ${SHAPE_IDS.join(', ')}.`); return null; }
      const at = place(b, it.center, `${where}.center`);
      if (!at) return null;
      const w = positive(b, it.width, where, 'width'), h = positive(b, it.height, where, 'height');
      if (!w || !h) { if (!w && !h) b.bad(`${where}: "width" and "height" (drawing units).`); return null; }
      if (it.fill != null && !SHAPE_FILLS.includes(it.fill)) { b.bad(`${where}: "fill" is ${SHAPE_FILLS.join(', ')}.`); return null; }
      if (it.angle != null && !Number.isFinite(it.angle)) { b.bad(`${where}: "angle" in degrees.`); return null; }
      return { ...base, shape: it.shape, at, w, h, angle: (it.angle || 0) * DEG, fill: it.fill, outline: positive(b, it.outline, where, 'outline'), dash: !!it.dash };
    }
    default:
      b.bad(`${where}: unknown type ${JSON.stringify(it.type)}. Use one of ${DRAWING_TYPES.join(', ')}.`);
      return null;
  }
}

/** Layers, line styles and the canvas colour: before solving (layers
 *  decide which shapes close an area for a fill). */
export function applyLayers(b, project) {
  if (b.layerNames.length) {
    project.layers = b.layerNames.map(l => new Layer(l.name, { visible: l.visible, opacity: l.opacity }));
    project.activeLayerId = project.layers[project.layers.length - 1].id;
  }
  b.layerId = (name) => (name ? project.layers.find(l => l.name === name).id : project.layers[0].id);
  for (const s of b.shapes) {
    const e = s.entity;
    if (!e) continue;
    e.layerId = b.layerId(s.layer);
    if (s.lineStyle || s.lineWidth) e.style = { ...(s.lineWidth ? { lineWidth: s.lineWidth } : {}), ...(s.lineStyle ? { lineStyle: s.lineStyle } : {}) };
  }
  // Points standing on their own go on their point shape's layer, else the first.
  for (const e of project.active().entities) if (!e.layerId) e.layerId = b.layerId(null);
  project.background = b.background;
}

/** Drawing items and fills, placed on the solved geometry. */
export function applyDrawing(b, project) {
  const sketch = project.active();
  const lookup = anchorLookup([sketch]);
  const ptOf = (n) => b.ptOf(n);
  const xy = (p) => (p.xy ? { x: p.xy[0], y: p.xy[1] } : { x: ptOf(p.node).x, y: ptOf(p.node).y });
  const size = drawingSize(sketch);
  const unit = size / 100;                               // 1 % of the drawing
  const nice = (v) => { const e = 10 ** Math.floor(Math.log10(v)); const m = v / e; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e; };
  const DEF = { text: nice(3 * unit), pen: nice(0.4 * unit), marker: nice(2.5 * unit), arrow: nice(0.35 * unit), shape: nice(0.35 * unit) };
  const groups = new Map();
  const groupId = (g) => { if (!groups.has(g)) groups.set(g, newId('g')); return groups.get(g); };

  for (const f of b.fills || []) {
    const layerId = b.layerId(f.layer);
    const shapes = sketch.entities.filter(e => !e.construction && e.layerId === layerId && (e instanceof Line || e instanceof Arc || e instanceof Circle || e instanceof Bezier));
    const seed = { x: f.at[0], y: f.at[1] };
    if (!findFaceAt(shapes, seed)) { b.bad(`${f.where}: [${f.at}] isn't inside a closed outline of CAD shapes${f.layer ? ` on layer "${f.layer}"` : ''} (after solving). Put "at" inside the area, and close the outline (shapes whose ends meet).`); continue; }
    sketch.fills.push({ id: newId('f'), layerId, color: f.color, opacity: f.opacity, seed });
  }

  for (const it of b.items || []) {
    const base = { id: newId('k'), layerId: b.layerId(it.layer), color: it.color, opacity: it.opacity };
    if (it.group) base.group = groupId(it.group);
    let item;
    if (it.type === 'text') {
      item = { ...base, kind: 'text', text: it.text, size: it.size || DEF.text, bold: it.bold, points: [{ x: 0, y: 0 }] };
      if (it.box) item.box = it.box;
      if (it.angle) item.angle = it.angle;
      const c = xy(it.at);
      placeTextCenter(item, c);
      if (it.align !== 'center') {                       // "at" is the left / right end of the line
        const w = textBox(item).w + (item.box ? 2 * BOX_PAD * item.size : 0), k = it.align === 'left' ? 0.5 : -0.5;
        const u = { x: Math.cos(item.angle || 0), y: Math.sin(item.angle || 0) };
        placeTextCenter(item, { x: c.x + u.x * w * k, y: c.y + u.y * w * k });
      }
    } else if (it.type === 'arrow') {
      const end = (e) => {
        if (e.shape) return { at: e.t != null ? { to: e.shape.entity.id, t: e.t } : { to: e.shape.entity.id, a: e.a } };
        if (e.node != null) return { at: { to: ptOf(e.node).id } };
        return { xy: { x: e.xy[0], y: e.xy[1] } };
      };
      const ends = [end(it.from), end(it.to)];
      const pts = ends.map(e => (e.at ? attachPoint(e.at, lookup) : e.xy));
      if (Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 1e-9) { b.bad(`${it.where}: both ends are at the same place.`); continue; }
      item = { ...base, kind: 'arrow', width: it.width || DEF.arrow, points: pts };
      if (it.head && it.head !== 'filled') item.head = it.head;
      if (it.tips && it.tips !== 'end') item.tips = it.tips;
      if (it.dash) item.dash = true;
      if (ends.some(e => e.at)) item.at = ends.map(e => e.at || null);
    } else if (it.type === 'pen' || it.type === 'marker') {
      item = { ...base, kind: it.type, width: it.width || DEF[it.type], points: it.points.map(([x, y]) => ({ x, y })) };
      if (it.dash) item.dash = true;
    } else if (it.type === 'image') {
      const id = registerImage(it.src, it.image);
      const c = xy(it.at), u = { x: Math.cos(it.angle), y: Math.sin(it.angle) }, v = { x: -u.y, y: u.x };
      const at = (sx, sy) => ({ x: c.x + u.x * sx * it.w / 2 + v.x * sy * it.h / 2, y: c.y + u.y * sx * it.w / 2 + v.y * sy * it.h / 2 });
      item = { id: base.id, layerId: base.layerId, opacity: base.opacity, ...(base.group ? { group: base.group } : {}), kind: 'image', image: id, points: [at(-1, 1), at(1, 1), at(-1, -1)] };
    } else if (it.type === 'trace') {
      const t = tracePointPath(project, sketch, ptOf(it.at.node));
      if (!t.ok) { b.bad(`${it.where}: ${t.message}`); continue; }
      item = { ...base, kind: 'pen', width: it.width || DEF.pen, points: t.points, traces: t.traces };
      if (it.dash) item.dash = true;
    } else if (it.type === 'shape') {
      const c = xy(it.at), u = { x: Math.cos(it.angle), y: Math.sin(it.angle) }, v = { x: -u.y, y: u.x };
      const at = (sx, sy) => ({ x: c.x + u.x * sx * it.w / 2 + v.x * sy * it.h / 2, y: c.y + u.y * sx * it.w / 2 + v.y * sy * it.h / 2 });
      item = { ...base, kind: 'shape', shape: it.shape, width: it.outline || DEF.shape, points: [at(-1, 1), at(1, 1), at(-1, -1)] };
      if (it.fill && it.fill !== 'none') item.fill = it.fill;
      if (it.dash) item.dash = true;
    }
    if (it.link) {
      const anchor = it.link.shape ? it.link.shape.entity : ptOf(it.link.node);
      linkItems([item], anchor);
      if (it.link.t != null) item.link = { to: anchor.id, t: it.link.t, f: anchorFrame(anchor, it.link.t, item.kind === 'shape' || item.kind === 'image') };
    }
    sketch.strokes.push(item);
  }
  // The editor's tool sizes, so what the user adds by hand matches.
  project.sizes = { ...project.sizes, text: DEF.text, pen: DEF.pen, marker: DEF.marker, arrow: DEF.arrow, shape: DEF.shape };
}

function drawingSize(sketch) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const e of sketch.entities) {
    if (e instanceof Line) { add(e.p1.x, e.p1.y); add(e.p2.x, e.p2.y); }
    else if (e instanceof Circle || e instanceof Arc) { add(e.center.x - e.r, e.center.y - e.r); add(e.center.x + e.r, e.center.y + e.r); }
    else if (e instanceof Point) add(e.x, e.y);
  }
  return Number.isFinite(x0) ? Math.max(x1 - x0, y1 - y0, 1e-6) || 100 : 100;
}

/* =============== PROJECT → SPEC ================================ */

/**
 * The drawing side of projectToSpec: fills `spec` and notes what can't be
 * carried in `unsupported`. `P(id)` names a point; shape ids are entity ids.
 */
export function presentationToSpec(project, sketch, spec, unsupported, P, copies = new Set()) {
  const layerName = new Map(project.layers.map(l => [l.id, l.name]));
  const first = project.layers[0]?.id;
  if (project.layers.length > 1 || (project.layers[0] && (project.layers[0].visible === false || project.layers[0].opacity !== 1))) {
    spec.layers = project.layers.map(l => (l.visible === false || l.opacity !== 1 ? { name: l.name, visible: l.visible !== false, opacity: l.opacity } : l.name));
    if (new Set(project.layers.map(l => l.name)).size !== project.layers.length) unsupported.add('two layers with the same name');
  }
  const layer = (id) => (spec.layers && id && id !== first ? { layer: layerName.get(id) } : {});
  if (project.background) spec.background = project.background;
  const byId = new Map(sketch.entities.map(e => [e.id, e]));

  // CAD shapes: layer and line look.
  for (const s of spec.shapes) {
    const e = byId.get(s.id);
    if (!e) continue;
    Object.assign(s, layer(e.layerId));
    if (e.style?.lineStyle && e.style.lineStyle !== 'solid') s.line_style = e.style.lineStyle;
    if (e.style?.lineWidth && e.style.lineWidth !== 1.4) s.weight = e.style.lineWidth;
  }

  if (sketch.fills?.length) {
    spec.fills = sketch.fills.map(f => ({ at: [r6(f.seed.x), r6(f.seed.y)], color: f.color, ...(f.opacity !== 0.35 ? { opacity: f.opacity } : {}), ...layer(f.layerId) }));
  }

  const linkOut = (link) => {
    if (!link) return {};
    if (copies.has(link.to)) { unsupported.add('relations or links on pattern copies'); return {}; }
    const e = byId.get(link.to);
    const to = e && !(e instanceof Point) ? e.id : P(link.to);
    if (!to) return {};
    return { link: link.t != null && e instanceof Line ? { to, t: r6(link.t) } : to };
  };
  const pt = (p) => [r6(p.x), r6(p.y)];
  const common = (it) => ({
    ...(it.color && it.color !== '#111418' ? { color: it.color } : {}),
    ...(it.opacity != null && it.opacity !== 1 ? { opacity: r6(it.opacity) } : {}),
    ...layer(it.layerId), ...(it.group ? { group: it.group } : {}), ...linkOut(it.link),
  });
  const items = [];
  for (const it of sketch.strokes || []) {
    if (it.kind === 'text') {
      const c = textCenter(it);
      items.push({ type: 'text', text: it.text, at: pt(c), size: r6(it.size), ...(it.bold ? { bold: true } : {}),
        ...(it.angle ? { angle: r6(it.angle / DEG) } : {}),
        ...(it.box ? { box: it.box.color === PAPER ? true : it.box.color, ...(it.box.border ? { border: true } : {}) } : {}), ...common(it) });
    } else if (it.kind === 'arrow') {
      const end = (k) => {
        const a = it.at?.[k];
        if (a && copies.has(a.to)) unsupported.add('relations or links on pattern copies');
        const e = a && (byId.get(a.to) || null);
        if (a && e instanceof Line) return { on: e.id, t: r6(a.t ?? 0.5) };
        if (a && (e instanceof Circle || e instanceof Arc)) return { on: e.id, angle: r6((a.a ?? 0) / DEG) };
        if (a && P(a.to)) return P(a.to);
        return pt(it.points[k]);
      };
      items.push({ type: 'arrow', from: end(0), to: end(1), width: r6(it.width), ...(it.head ? { head: it.head } : {}), ...(it.tips ? { tips: it.tips } : {}), ...(it.dash ? { dash: true } : {}), ...common(it) });
    } else if (it.kind === 'pen' && it.traces) {
      const p = P(it.traces.point);
      if (!p) { unsupported.add('a traced path whose point is gone'); continue; }
      items.push({ type: 'trace', point: p, width: r6(it.width), ...(it.dash ? {} : { dash: false }), ...common(it) });
    } else if (it.kind === 'pen' || it.kind === 'marker') {
      items.push({ type: it.kind, points: it.points.map(pt), width: r6(it.width), ...(it.dash ? { dash: true } : {}), ...common(it) });
    } else if (it.kind === 'shape') {
      const [a, b2, c] = it.points;
      const ux = b2.x - a.x, uy = b2.y - a.y, vx = a.x - c.x, vy = a.y - c.y;
      const w = Math.hypot(ux, uy), h = Math.hypot(vx, vy);
      if (Math.abs(ux * vx + uy * vy) > 1e-6 * w * h || ux * vy - uy * vx < 0) unsupported.add('stretched or flipped shapes');
      items.push({ type: 'shape', shape: it.shape, center: [r6((b2.x + c.x) / 2), r6((b2.y + c.y) / 2)], width: r6(w), height: r6(h),
        ...(Math.abs(Math.atan2(uy, ux)) > 1e-9 ? { angle: r6(Math.atan2(uy, ux) / DEG) } : {}),
        outline: r6(it.width), ...(it.fill ? { fill: it.fill } : {}), ...(it.dash ? { dash: true } : {}), ...common(it) });
    } else if (it.kind === 'image') {
      const [a, b2, c] = it.points;
      const ux = b2.x - a.x, uy = b2.y - a.y, vx = a.x - c.x, vy = a.y - c.y;
      const w = Math.hypot(ux, uy), h = Math.hypot(vx, vy);
      if (Math.abs(ux * vx + uy * vy) > 1e-6 * w * h || ux * vy - uy * vx < 0) unsupported.add('stretched or flipped pictures');
      items.push({ type: 'image', src: `image:${it.image}`, center: [r6((b2.x + c.x) / 2), r6((b2.y + c.y) / 2)], width: r6(w), height: r6(h),
        ...(Math.abs(Math.atan2(uy, ux)) > 1e-9 ? { angle: r6(Math.atan2(uy, ux) / DEG) } : {}), ...common({ ...it, color: undefined }) });
    } else unsupported.add(`${it.kind} items`);
  }
  if (items.length) spec.drawing = items;
}

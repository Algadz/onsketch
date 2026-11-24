import { LENGTH_UNITS } from './expr.js';

/* =============== DXF IMPORT ====================================
   An ASCII DXF (any version from R12, as CAD, CAM and laser-cutter
   programs write them) turned into an OnSketch drawing (saved form), to
   be inserted as a part at real size (app/dxf-import.js, core/insert.js).

   Read from the ENTITIES section:
     LINE, CIRCLE, ARC, POINT
     LWPOLYLINE and POLYLINE / VERTEX: straight segments as lines, bulged
       ones as arcs; closed ones close
   Ends that meet (within a hair of the drawing's size) are joined with
   coincident relations, so outlines stay connected when dragged.
   Each DXF layer becomes a layer ("0" is called "DXF").
   Units: the header's $INSUNITS (in, ft, mi, mm, cm, m, km), converted to
   the document unit; a file without units is taken as millimetres.
   Not read (counted, and said): text, dimensions, hatches, splines,
   ellipses, blocks (INSERT) and anything else. Objects mirrored with an
   extrusion of (0, 0, −1), as some programs write them, are flipped back.
   ============================================================ */

/** $INSUNITS code → unit name (LENGTH_UNITS key). */
const INSUNITS = { 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km' };
export const DXF_MAX_SHAPES = 20000;
const TAU = Math.PI * 2;

/** The group-code pairs of a DXF file. */
function pairs(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) break;
    out.push([code, lines[i + 1]]);
  }
  return out;
}
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/**
 * Reads the shapes of a DXF.
 * @returns {{ shapes: object[], unit: string|null, layers: string[], skipped: Record<string, number> }}
 *   shapes in the file's units: { kind: 'line', layer, a:{x,y}, b }, { kind: 'circle', layer, c, r },
 *   { kind: 'arc', layer, c, r, a0, a1 } (radians, counter-clockwise), { kind: 'point', layer, p }
 */
export function readDXF(text) {
  const P = pairs(text);
  if (!P.length || !P.some(([c, v]) => c === 0 && v.trim() === 'SECTION')) throw new Error('This file is not an ASCII DXF.');
  let unit = null;
  for (let i = 0; i < P.length - 1; i++) {
    if (P[i][0] === 9 && P[i][1].trim() === '$INSUNITS') { unit = INSUNITS[parseInt(P[i + 1][1], 10)] || null; break; }
  }
  // The ENTITIES section, split into entities (each starts with code 0).
  let start = -1;
  for (let i = 0; i < P.length - 1; i++) if (P[i][0] === 2 && P[i][1].trim() === 'ENTITIES' && P[i - 1]?.[1].trim() === 'SECTION') { start = i + 1; break; }
  if (start < 0) throw new Error('This DXF has no shapes (no ENTITIES section).');
  const ents = [];
  for (let i = start; i < P.length; i++) {
    const [c, v] = P[i];
    if (c !== 0) { if (ents.length) ents[ents.length - 1].g.push([c, v]); continue; }
    const type = v.trim();
    if (type === 'ENDSEC') break;
    ents.push({ type, g: [] });
  }
  const shapes = [], skipped = {}, layers = new Set();
  const skip = (t) => { skipped[t] = (skipped[t] || 0) + 1; };
  const first = (g, code, d = 0) => { const p = g.find(x => x[0] === code); return p ? num(p[1]) : d; };
  const layerOf = (g) => (g.find(x => x[0] === 8)?.[1].trim()) || '0';
  // Mirrored object coordinates (extrusion 0,0,−1): x flips, arcs turn the other way.
  const flipped = (g) => first(g, 230, 1) < 0;
  const add = (s) => { layers.add(s.layer); shapes.push(s); };

  /** Segments of a polyline's vertices (bulge on the vertex the segment starts from). */
  const polyline = (layer, verts, closed, flip) => {
    const n = verts.length;
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const a = verts[k], b = verts[(k + 1) % n];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) continue;
      const bulge = flip ? -a.bulge : a.bulge;
      if (!bulge) { add({ kind: 'line', layer, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } }); continue; }
      // bulge = tan(θ/4), θ the arc's sweep, positive counter-clockwise
      const theta = 4 * Math.atan(bulge), d = Math.hypot(b.x - a.x, b.y - a.y);
      const r = Math.abs(d / (2 * Math.sin(theta / 2)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
      const h = r * Math.cos(theta / 2) * Math.sign(theta);           // centre on the left for counter-clockwise
      const c = { x: mx - uy * h, y: my + ux * h };
      const angA = Math.atan2(a.y - c.y, a.x - c.x), angB = Math.atan2(b.y - c.y, b.x - c.x);
      add(theta > 0 ? { kind: 'arc', layer, c, r, a0: angA, a1: angB } : { kind: 'arc', layer, c, r, a0: angB, a1: angA });
    }
  };

  for (let i = 0; i < ents.length; i++) {
    const { type, g } = ents[i];
    const layer = layerOf(g), flip = flipped(g), fx = flip ? -1 : 1;
    if (type === 'LINE') add({ kind: 'line', layer, a: { x: first(g, 10), y: first(g, 20) }, b: { x: first(g, 11), y: first(g, 21) } });
    else if (type === 'CIRCLE') { const r = first(g, 40); if (r > 0) add({ kind: 'circle', layer, c: { x: fx * first(g, 10), y: first(g, 20) }, r }); }
    else if (type === 'ARC') {
      const r = first(g, 40); if (!(r > 0)) continue;
      let a0 = first(g, 50) * Math.PI / 180, a1 = first(g, 51) * Math.PI / 180;
      if (flip) [a0, a1] = [Math.PI - a1, Math.PI - a0];
      add({ kind: 'arc', layer, c: { x: fx * first(g, 10), y: first(g, 20) }, r, a0, a1 });
    } else if (type === 'POINT') add({ kind: 'point', layer, p: { x: first(g, 10), y: first(g, 20) } });
    else if (type === 'LWPOLYLINE') {
      const verts = [];
      for (const [c, v] of g) {
        if (c === 10) verts.push({ x: fx * num(v), y: 0, bulge: 0 });
        else if (c === 20 && verts.length) verts[verts.length - 1].y = num(v);
        else if (c === 42 && verts.length) verts[verts.length - 1].bulge = num(v);
      }
      polyline(layer, verts, (first(g, 70) & 1) === 1, flip);
    } else if (type === 'POLYLINE') {
      const flags = first(g, 70), verts = [];
      if (flags & (16 | 64)) { skip('3D mesh'); }
      for (i++; i < ents.length && ents[i].type === 'VERTEX'; i++) {
        const vg = ents[i].g;
        verts.push({ x: fx * first(vg, 10), y: first(vg, 20), bulge: first(vg, 42) });
      }
      if (ents[i]?.type !== 'SEQEND') i--;
      if (!(flags & (16 | 64))) polyline(layer, verts, (flags & 1) === 1, flip);
    } else if (type === 'SEQEND' || type === 'VERTEX') continue;
    else skip(type);
    if (shapes.length > DXF_MAX_SHAPES) throw new Error(`This DXF has more than ${DXF_MAX_SHAPES} shapes: too many to edit.`);
  }
  return { shapes, unit, layers: [...layers], skipped };
}

/**
 * A DXF as an OnSketch drawing (saved form), in the document's unit.
 * @param {string} text  the file
 * @param {string} docUnit  the open document's unit
 * @param {string} name  what the part is called
 * @returns {{ data: object, count: number, unit: string|null, skipped: Record<string, number> }}
 */
export function dxfToSketchData(text, docUnit = 'mm', name = 'DXF') {
  const { shapes, unit, layers, skipped } = readDXF(text);
  const k = (LENGTH_UNITS[unit || 'mm'] || 1) / (LENGTH_UNITS[docUnit] || 1);
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const layerIds = new Map(layers.map((l, i) => [l, `dl${i + 1}`]));
  const entities = [], ends = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  const P = (p) => { const o = { type: 'point', id: id('dp'), x: p.x * k, y: p.y * k }; acc(o.x, o.y); return o; };
  for (const s of shapes) {
    const layerId = layerIds.get(s.layer);
    if (s.kind === 'line') {
      const e = { type: 'line', id: id('de'), layerId, p1: P(s.a), p2: P(s.b) };
      entities.push(e);
      ends.push({ x: e.p1.x, y: e.p1.y, ref: { pointId: e.p1.id } }, { x: e.p2.x, y: e.p2.y, ref: { pointId: e.p2.id } });
    } else if (s.kind === 'circle') {
      const c = P(s.c), r = s.r * k;
      acc(c.x - r, c.y - r); acc(c.x + r, c.y + r);
      entities.push({ type: 'circle', id: id('de'), layerId, center: c, r });
    } else if (s.kind === 'arc') {
      const c = P(s.c), r = s.r * k;
      let a1 = s.a1;
      while (a1 <= s.a0) a1 += TAU;                    // counter-clockwise from a0 to a1
      const e = { type: 'arc', id: id('de'), layerId, center: c, r, a0: s.a0, a1, clockwise: false };
      acc(c.x - r, c.y - r); acc(c.x + r, c.y + r);
      entities.push(e);
      for (const which of ['start', 'end']) {
        const a = which === 'start' ? e.a0 : e.a1;
        ends.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), ref: { arcId: e.id, centerId: c.id, which } });
      }
    } else if (s.kind === 'point') {
      entities.push({ ...P(s.p), layerId });
    }
  }
  // Join ends that meet: one relation per extra end at the same spot.
  const size = Math.max(maxX - minX, maxY - minY, 1e-9);
  const tol = size * 1e-7;
  const constraints = [];
  const groups = new Map();
  const cell = (v) => Math.round(v / (tol * 10));
  for (const e of ends) {
    const key = cell(e.x) + ',' + cell(e.y);
    let g = groups.get(key);
    if (!g) {                                        // a neighbouring cell may hold it (rounding)
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
        const h = groups.get((cell(e.x) + dx) + ',' + (cell(e.y) + dy));
        if (h && Math.hypot(h[0].x - e.x, h[0].y - e.y) <= tol * 10) g = h;
      }
    }
    if (!g) groups.set(key, g = []);
    g.push(e);
  }
  for (const g of new Set(groups.values())) {
    for (let i = 1; i < g.length; i++) {
      const a = g[0].ref, b = g[i].ref;
      if (a.pointId && b.pointId) constraints.push({ id: id('dc'), kind: 'coincident', p1: a.pointId, p2: b.pointId });
      else if (a.pointId || b.pointId) constraints.push({ id: id('dc'), kind: 'arcEndpointCoincident', ref: a.pointId ? b : a, pointId: a.pointId || b.pointId });
      else if (a.arcId !== b.arcId) constraints.push({ id: id('dc'), kind: 'arcEndpointArcEndpointCoincident', ref1: a, ref2: b });
    }
  }
  const layersOut = layers.map(l => ({ id: layerIds.get(l), name: l === '0' ? 'DXF' : l }));
  const data = {
    version: 3, name, units: docUnit,
    activeLayerId: layersOut[0]?.id || 'dl1',
    layers: layersOut.length ? layersOut : [{ id: 'dl1', name: 'DXF' }],
    sketches: [{ id: 'ds1', name, entities, constraints, strokes: [], fills: [] }],
  };
  return { data, count: shapes.length, unit, skipped };
}

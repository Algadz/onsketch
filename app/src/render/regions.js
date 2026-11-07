/* =============== FILL REGIONS ==================================
   Finds closed profiles to fill. A profile is a chain of lines and
   arcs whose endpoints meet (by shared Point or within a tolerance),
   or a full circle. Branching networks (a node joined to 3+ edges)
   are skipped for now; a planar-face search can replace this later.

   Profiles that share a fill are drawn as one even-odd path, so a
   circle inside a filled rectangle becomes a hole.
   ============================================================ */
import { Line, Circle, Arc } from '../core/entities.js';
import { directedArcSpan } from '../core/math.js';

const TOL = 1e-6;

/** Merge endpoints closer than TOL using a spatial hash; returns a node id
 *  for a point. Checks neighbouring cells so rounding edges can't split
 *  two coincident points. */
function makeNodeIndex(tol = TOL) {
  const cells = new Map();
  let next = 0;
  return (p) => {
    const cx = Math.floor(p.x / tol), cy = Math.floor(p.y / tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells.get((cx + dx) + ',' + (cy + dy));
        if (!bucket) continue;
        for (const n of bucket) if (Math.abs(n.x - p.x) <= tol && Math.abs(n.y - p.y) <= tol) return n.id;
      }
    }
    const key = cx + ',' + cy;
    const n = { id: next++, x: p.x, y: p.y };
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(n);
    return n.id;
  };
}

/** Sample an arc as world-space points from its start to its end. */
export function arcPoints(arc) {
  const span = directedArcSpan(arc.a0, arc.a1, !!arc.clockwise);
  const steps = Math.max(8, Math.ceil(Math.abs(span) / (Math.PI / 32)));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = arc.a0 + span * (i / steps);
    out.push({ x: arc.center.x + arc.r * Math.cos(a), y: arc.center.y + arc.r * Math.sin(a) });
  }
  return out;
}

/**
 * @param {Array} entities  candidate entities (construction geometry should
 *                          already be filtered out)
 * @returns {{ loops: Array<Array<{x,y}>>, circles: Circle[] }}
 *          each loop is a closed polyline in world coordinates
 */
export function findClosedProfiles(entities) {
  const nodeOf = makeNodeIndex();
  const edges = [];
  const circles = [];
  for (const e of entities) {
    if (e instanceof Circle) { if (e.r > 0) circles.push(e); continue; }
    if (e instanceof Line) {
      edges.push({ e, a: nodeOf(e.p1), b: nodeOf(e.p2) });
    } else if (e instanceof Arc) {
      e.syncEnds();
      edges.push({ e, a: nodeOf(e.start), b: nodeOf(e.end) });
    }
  }

  const adj = new Map();
  edges.forEach((ed, i) => {
    if (ed.a === ed.b) return;   // zero-length line or full-turn arc: ignore
    for (const n of [ed.a, ed.b]) {
      if (!adj.has(n)) adj.set(n, []);
      adj.get(n).push(i);
    }
  });

  const loops = [];
  const used = new Set();
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i) || edges[i].a === edges[i].b) continue;
    // Walk the chain; abort if any node is not of degree exactly 2.
    const chain = [];
    let node = edges[i].a, ei = i, ok = true;
    const seenHere = new Set();
    while (true) {
      if ((adj.get(node) || []).length !== 2) { ok = false; break; }
      const ed = edges[ei];
      const forward = ed.a === node;
      chain.push({ ed, forward });
      seenHere.add(ei);
      node = forward ? ed.b : ed.a;
      if ((adj.get(node) || []).length !== 2) { ok = false; break; }
      const nextEi = adj.get(node).find(k => k !== ei);
      if (nextEi === i) break;                 // closed
      if (seenHere.has(nextEi)) { ok = false; break; }
      ei = nextEi;
    }
    for (const k of seenHere) used.add(k);
    if (!ok || chain.length < 2) continue;

    const pts = [];
    for (const { ed, forward } of chain) {
      let seg;
      if (ed.e instanceof Line) seg = [ed.e.p1, ed.e.p2];
      else seg = arcPoints(ed.e);
      if (!forward) seg = seg.slice().reverse();
      for (let k = (pts.length ? 1 : 0); k < seg.length; k++) pts.push({ x: seg[k].x, y: seg[k].y });
    }
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) <= TOL && Math.abs(first.y - last.y) <= TOL) pts.pop();
    loops.push(pts);
  }
  return { loops, circles };
}

/* ---------------- Planar faces (fill tool) ----------------------
   Treats lines and arcs as a planar graph (joined at endpoints, no
   intersection splitting) and traces its faces: at every node, leave
   by the edge immediately clockwise from the one you arrived on.
   Bounded faces come out counter-clockwise (positive area); the outer
   boundary of each connected piece comes out clockwise. Circles are
   closed curves on their own. */

function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function circlePoints(c, n = 72) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: c.center.x + c.r * Math.cos(a), y: c.center.y + c.r * Math.sin(a) });
  }
  return out;
}

/** All face cycles: { pts, area, ids } where ids are the entities on the
 *  boundary (edges walked both ways, i.e. spikes, are left out). */
export function planarCycles(entities) {
  const nodeOf = makeNodeIndex();
  const half = [];
  const cycles = [];
  for (const e of entities) {
    if (e instanceof Circle) {
      if (e.r > 0) {
        const pts = circlePoints(e);
        cycles.push({ pts, area: signedArea(pts), ids: [e.id] });
        cycles.push({ pts: pts.slice().reverse(), area: -signedArea(pts), ids: [e.id] });
      }
      continue;
    }
    let pts;
    if (e instanceof Line) pts = [{ x: e.p1.x, y: e.p1.y }, { x: e.p2.x, y: e.p2.y }];
    else if (e instanceof Arc) { e.syncEnds(); pts = arcPoints(e); }
    else continue;
    const a = nodeOf(pts[0]), b = nodeOf(pts[pts.length - 1]);
    if (a === b) continue;
    const h0 = { e, from: a, to: b, pts };
    const h1 = { e, from: b, to: a, pts: pts.slice().reverse() };
    h0.twin = h1; h1.twin = h0;
    for (const h of [h0, h1]) h.angle = Math.atan2(h.pts[1].y - h.pts[0].y, h.pts[1].x - h.pts[0].x);
    half.push(h0, h1);
  }
  const out = new Map();
  for (const h of half) {
    if (!out.has(h.from)) out.set(h.from, []);
    out.get(h.from).push(h);
  }
  for (const list of out.values()) list.sort((p, q) => p.angle - q.angle);
  const next = (h) => {
    const list = out.get(h.to);
    const i = list.indexOf(h.twin);
    return list[(i - 1 + list.length) % list.length];
  };

  const visited = new Set();
  for (const start of half) {
    if (visited.has(start)) continue;
    const walk = [];
    let h = start, guard = 0;
    while (!visited.has(h) && guard++ < half.length + 1) {
      visited.add(h); walk.push(h); h = next(h);
    }
    if (h !== start) continue;          // malformed; shouldn't happen
    const pts = [];
    for (const w of walk) for (let k = 0; k < w.pts.length - 1; k++) pts.push(w.pts[k]);
    const both = new Set(walk.filter(w => walk.includes(w.twin)).map(w => w.e.id));
    const ids = [...new Set(walk.map(w => w.e.id))].filter(id => !both.has(id));
    cycles.push({ pts, area: signedArea(pts), ids });
  }
  return cycles;
}

/** Region under `pt`: the smallest bounded face containing it, plus the
 *  pieces sitting directly inside it as holes. Returns null when the
 *  point is outside every closed region. */
export function findFaceAt(entities, pt) {
  const cycles = planarCycles(entities);
  const EPSA = 1e-9;
  let face = null;
  for (const c of cycles) {
    if (c.area <= EPSA || !c.ids.length) continue;
    if (!pointInPolygon(pt, c.pts)) continue;
    if (!face || c.area < face.area) face = c;
  }
  if (!face) return null;
  // Outer boundaries of other pieces that lie inside the face and do not
  // contain the point. Keep only the outermost of nested ones.
  const inner = cycles.filter(c => c.area < -EPSA && c.ids.length
    && !c.ids.every(id => face.ids.includes(id))
    && pointInPolygon(c.pts[0], face.pts) && !pointInPolygon(pt, c.pts));
  const holes = inner.filter(c => !inner.some(o => o !== c && pointInPolygon(c.pts[0], o.pts)));
  return { outer: face.ids, holes: holes.map(h => h.ids), area: face.area };
}

/** Closed outline(s) for a stored fill, rebuilt from its boundary
 *  entities so the fill follows the geometry. */
export function fillOutline(entities) {
  const { loops, circles } = findClosedProfiles(entities);
  return [...loops, ...circles.map(c => circlePoints(c))];
}

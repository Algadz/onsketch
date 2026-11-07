/* =============== REGIONS =======================================
   Closed regions formed by sketch geometry, for fills.

   Geometry is turned into a planar arrangement: lines, arcs and
   circles become straight segments (curves are sampled), every
   segment is split where it touches or crosses another, overlapping
   segments are merged, and the faces of the resulting graph are
   traced. So shapes that share an edge, a corner, or part of a side,
   and shapes that cross, all give the regions you see on screen.
   ============================================================ */
import { Line, Circle, Arc } from './entities.js';
import { directedArcSpan } from './math.js';

const TOL = 1e-6;
const ARC_STEP = Math.PI / 32;

/** Merge points closer than TOL using a spatial hash; returns a node id.
 *  Checks neighbouring cells so rounding can't split two coincident
 *  points. `nodes` collects the coordinates. */
function makeNodeIndex(tol = TOL) {
  const cells = new Map();
  const nodes = [];
  const index = (p) => {
    const cx = Math.floor(p.x / tol), cy = Math.floor(p.y / tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells.get((cx + dx) + ',' + (cy + dy));
        if (!bucket) continue;
        for (const n of bucket) if (Math.abs(n.x - p.x) <= tol && Math.abs(n.y - p.y) <= tol) return n.id;
      }
    }
    const key = cx + ',' + cy;
    const n = { id: nodes.length, x: p.x, y: p.y };
    nodes.push(n);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(n);
    return n.id;
  };
  index.nodes = nodes;
  return index;
}

/** Sample an arc as world-space points from its start to its end. */
export function arcPoints(arc) {
  const span = directedArcSpan(arc.a0, arc.a1, !!arc.clockwise);
  const steps = Math.max(8, Math.ceil(Math.abs(span) / ARC_STEP));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = arc.a0 + span * (i / steps);
    out.push({ x: arc.center.x + arc.r * Math.cos(a), y: arc.center.y + arc.r * Math.sin(a) });
  }
  return out;
}

function circlePoints(c) {
  const n = 64;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: c.center.x + c.r * Math.cos(a), y: c.center.y + c.r * Math.sin(a) });
  }
  out[n] = { ...out[0] };
  return out;
}

/** Polyline for a fillable entity, or null. */
function polylineOf(e) {
  if (e instanceof Line) return [{ x: e.p1.x, y: e.p1.y }, { x: e.p2.x, y: e.p2.y }];
  if (e instanceof Arc) { e.syncEnds(); return arcPoints(e); }
  if (e instanceof Circle) return e.r > 0 ? circlePoints(e) : null;
  return null;
}

export function signedArea(pts) {
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

/* ---------------- Arrangement ---------------- */

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/** Split parameters where segment 1 (p→q) and segment 2 (r→s) meet:
 *  a crossing, a T-junction, or a collinear overlap. */
function meetParams(p, q, r, s, out1, out2) {
  const d1x = q.x - p.x, d1y = q.y - p.y, d2x = s.x - r.x, d2y = s.y - r.y;
  const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
  if (l1 < TOL || l2 < TOL) return;
  const e1 = TOL / l1, e2 = TOL / l2;
  const denom = cross(d1x, d1y, d2x, d2y);
  const rpx = r.x - p.x, rpy = r.y - p.y;
  if (Math.abs(denom) > 1e-12 * l1 * l2) {
    const t = cross(rpx, rpy, d2x, d2y) / denom;
    const u = cross(rpx, rpy, d1x, d1y) / denom;
    if (t >= -e1 && t <= 1 + e1 && u >= -e2 && u <= 1 + e2) {
      out1.push(Math.min(1, Math.max(0, t)));
      out2.push(Math.min(1, Math.max(0, u)));
    }
    return;
  }
  // Parallel: only collinear overlaps matter.
  if (Math.abs(cross(d1x, d1y, rpx, rpy)) / l1 > TOL) return;
  const on1 = (x, y) => ((x - p.x) * d1x + (y - p.y) * d1y) / (l1 * l1);
  const on2 = (x, y) => ((x - r.x) * d2x + (y - r.y) * d2y) / (l2 * l2);
  for (const [x, y] of [[r.x, r.y], [s.x, s.y]]) { const t = on1(x, y); if (t > e1 && t < 1 - e1) out1.push(t); }
  for (const [x, y] of [[p.x, p.y], [q.x, q.y]]) { const u = on2(x, y); if (u > e2 && u < 1 - e2) out2.push(u); }
}

/** Planar graph of the entities: nodes and merged edges, each edge
 *  remembering which entities it came from. */
export function buildArrangement(entities) {
  const segs = [];
  for (const e of entities) {
    const pl = polylineOf(e);
    if (!pl) continue;
    for (let i = 0; i < pl.length - 1; i++) {
      const p = pl[i], q = pl[i + 1];
      if (Math.abs(p.x - q.x) <= TOL && Math.abs(p.y - q.y) <= TOL) continue;
      segs.push({ p, q, id: e.id, ts: [0, 1],
        minX: Math.min(p.x, q.x) - TOL, maxX: Math.max(p.x, q.x) + TOL,
        minY: Math.min(p.y, q.y) - TOL, maxY: Math.max(p.y, q.y) + TOL });
    }
  }

  // Candidate pairs through a uniform grid over the segments' bounds.
  if (segs.length > 1) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of segs) { minX = Math.min(minX, s.minX); minY = Math.min(minY, s.minY); maxX = Math.max(maxX, s.maxX); maxY = Math.max(maxY, s.maxY); }
    const n = Math.max(1, Math.ceil(Math.sqrt(segs.length)));
    const cw = Math.max((maxX - minX) / n, TOL), ch = Math.max((maxY - minY) / n, TOL);
    const grid = new Map();
    segs.forEach((s, i) => {
      const x0 = Math.floor((s.minX - minX) / cw), x1 = Math.floor((s.maxX - minX) / cw);
      const y0 = Math.floor((s.minY - minY) / ch), y1 = Math.floor((s.maxY - minY) / ch);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = gx * 100003 + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    });
    const seen = new Set();
    for (const cell of grid.values()) {
      for (let a = 0; a < cell.length; a++) {
        for (let b = a + 1; b < cell.length; b++) {
          const i = cell[a], j = cell[b];
          const key = i < j ? i * segs.length + j : j * segs.length + i;
          if (seen.has(key)) continue;
          seen.add(key);
          const s1 = segs[i], s2 = segs[j];
          if (s1.maxX < s2.minX || s2.maxX < s1.minX || s1.maxY < s2.minY || s2.maxY < s1.minY) continue;
          meetParams(s1.p, s1.q, s2.p, s2.q, s1.ts, s2.ts);
        }
      }
    }
  }

  const nodeOf = makeNodeIndex();
  const edges = new Map();     // "a,b" (a<b) → { a, b, ids:Set }
  for (const s of segs) {
    const ts = [...new Set(s.ts)].sort((x, y) => x - y);
    let prev = null;
    for (const t of ts) {
      const node = nodeOf({ x: s.p.x + (s.q.x - s.p.x) * t, y: s.p.y + (s.q.y - s.p.y) * t });
      if (prev !== null && prev !== node) {
        const a = Math.min(prev, node), b = Math.max(prev, node);
        const k = a + ',' + b;
        if (!edges.has(k)) edges.set(k, { a, b, ids: new Set() });
        edges.get(k).ids.add(s.id);
      }
      prev = node;
    }
  }
  return { nodes: nodeOf.nodes, edges: [...edges.values()] };
}

/** Every face cycle of the arrangement: { pts, area, ids }. At each node
 *  the walk leaves by the edge just clockwise of the one it came in on,
 *  so bounded faces come out counter-clockwise (area > 0) and the outer
 *  boundary of each connected piece clockwise (area < 0). */
export function planarCycles(entities) {
  const { nodes, edges } = buildArrangement(entities);
  const half = [];
  for (const e of edges) {
    const h0 = { from: e.a, to: e.b, ids: e.ids }, h1 = { from: e.b, to: e.a, ids: e.ids };
    h0.twin = h1; h1.twin = h0;
    for (const h of [h0, h1]) {
      const p = nodes[h.from], q = nodes[h.to];
      h.angle = Math.atan2(q.y - p.y, q.x - p.x);
    }
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
  const cycles = [];
  const visited = new Set();
  for (const start of half) {
    if (visited.has(start)) continue;
    const walk = [];
    let h = start;
    while (!visited.has(h)) { visited.add(h); walk.push(h); h = next(h); }
    if (h !== start) continue;
    const pts = walk.map(w => ({ x: nodes[w.from].x, y: nodes[w.from].y }));
    const ids = new Set();
    for (const w of walk) for (const id of w.ids) ids.add(id);
    cycles.push({ pts, area: signedArea(pts), ids: [...ids] });
  }
  return cycles;
}

/** Bounded faces (counter-clockwise outlines) — what a set of filled
 *  shapes covers. Filling them all non-zero gives the union. */
export function boundedFaces(entities) {
  return planarCycles(entities).filter(c => c.area > 1e-9).map(c => c.pts);
}

/** Region under `pt`: the smallest bounded face containing it, plus the
 *  separate pieces sitting directly inside it as holes. Returns null
 *  when the point is outside every closed region. */
export function findFaceAt(entities, pt) {
  const cycles = planarCycles(entities);
  const EPSA = 1e-9;
  let face = null;
  for (const c of cycles) {
    if (c.area <= EPSA || !pointInPolygon(pt, c.pts)) continue;
    if (!face || c.area < face.area) face = c;
  }
  if (!face) return null;
  const inner = cycles.filter(c => c.area < -EPSA
    && pointInPolygon(c.pts[0], face.pts) && !pointInPolygon(pt, c.pts));
  const holes = inner.filter(c => !inner.some(o => o !== c && pointInPolygon(c.pts[0], o.pts)));
  const ids = new Set(face.ids);
  for (const h of holes) for (const id of h.ids) ids.add(id);
  return { outer: face.pts, holes: holes.map(h => h.pts), ids: [...ids], area: face.area };
}

/** True when pt is inside the region (outer, not in a hole). */
export function regionContains(region, pt) {
  return pointInPolygon(pt, region.outer) && !region.holes.some(h => pointInPolygon(pt, h));
}

/** A point well inside a region: middle of the widest inside span on a
 *  few horizontal scan lines. Used to keep a fill's anchor inside its
 *  region while the geometry moves. */
export function interiorPoint(region) {
  const rings = [region.outer, ...region.holes];
  let minY = Infinity, maxY = -Infinity;
  for (const p of region.outer) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  let best = null;
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
    const y = minY + (maxY - minY) * f;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (!best || w > best.w) best = { w, x: (xs[k] + xs[k + 1]) / 2, y };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/* ---------------- Simple loops (legacy fills) ---------------- */

/**
 * Closed chains where every node joins exactly two edges, plus circles.
 * Only used to place an anchor for fills saved before the arrangement.
 */
export function findClosedProfiles(entities) {
  const nodeOf = makeNodeIndex();
  const edges = [];
  const circles = [];
  for (const e of entities) {
    if (e instanceof Circle) { if (e.r > 0) circles.push(e); continue; }
    if (e instanceof Line) edges.push({ e, a: nodeOf(e.p1), b: nodeOf(e.p2) });
    else if (e instanceof Arc) { e.syncEnds(); edges.push({ e, a: nodeOf(e.start), b: nodeOf(e.end) }); }
  }
  const adj = new Map();
  edges.forEach((ed, i) => {
    if (ed.a === ed.b) return;
    for (const n of [ed.a, ed.b]) {
      if (!adj.has(n)) adj.set(n, []);
      adj.get(n).push(i);
    }
  });
  const loops = [];
  const used = new Set();
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i) || edges[i].a === edges[i].b) continue;
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
      if (nextEi === i) break;
      if (seenHere.has(nextEi)) { ok = false; break; }
      ei = nextEi;
    }
    for (const k of seenHere) used.add(k);
    if (!ok || chain.length < 2) continue;
    const pts = [];
    for (const { ed, forward } of chain) {
      let seg = ed.e instanceof Line ? [ed.e.p1, ed.e.p2] : arcPoints(ed.e);
      if (!forward) seg = seg.slice().reverse();
      for (let k = (pts.length ? 1 : 0); k < seg.length; k++) pts.push({ x: seg[k].x, y: seg[k].y });
    }
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) <= TOL && Math.abs(first.y - last.y) <= TOL) pts.pop();
    loops.push(pts);
  }
  return { loops, circles };
}

/** Cheap signature of the geometry of some entities, for caching. */
export function geometryKey(entities) {
  const parts = [];
  for (const e of entities) {
    if (e instanceof Line) parts.push(e.id, e.p1.x, e.p1.y, e.p2.x, e.p2.y);
    else if (e instanceof Circle) parts.push(e.id, e.center.x, e.center.y, e.r);
    else if (e instanceof Arc) parts.push(e.id, e.center.x, e.center.y, e.r, e.a0, e.a1, e.clockwise ? 1 : 0);
  }
  return parts.join(',');
}

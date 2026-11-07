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

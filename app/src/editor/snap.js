import { EPS, angleOnDirectedArc, dist } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';

/* =============== 7. SNAP ENGINE =============================== */
export class SnapEngine {
  constructor() { this.tolPx = 10; }
  find(world, view, sketches, options = {}) {
    if (!sketches || !sketches.length) return null;
    const tol = this.tolPx / view.zoom;
    let best = null;
    // entity attached to the snap is the *thing* the constraint will
    // reference: the Point itself for endpoints, the Line for midpoints,
    // the Circle/Arc for centers and quadrants, null for origin.
    const priority = (kind) => {
      if (kind === 'endpoint') return 5;
      if (kind === 'center') return 4;
      if (kind === 'midpoint' || kind === 'quadrant') return 3;
      if (kind === 'origin') return 2;
      return 1; // on-line / on-circle are useful, but lose to nearby points.
    };
    const consider = (pt, kind, entity) => {
      const d = dist(pt, world);
      if (d > tol) return;
      const p = priority(kind);
      const candidate = { x: pt.x, y: pt.y, kind, entity, _d: d, _p: p };
      if (options.ignore && options.ignore(candidate)) return;
      if (!best || p > best._p || (p === best._p && d < best._d)) {
        best = candidate;
      }
    };
    for (const sketch of sketches) {
      for (const e of sketch.entities) {
        if (this.entityFilter && !this.entityFilter(e)) continue;
        if (e instanceof Line) {
          consider(e.p1, 'endpoint', e.p1);
          consider(e.p2, 'endpoint', e.p2);
          consider({ x:(e.p1.x+e.p2.x)/2, y:(e.p1.y+e.p2.y)/2 }, 'midpoint', e);
          // On-line snap: foot of perpendicular from cursor onto the line
          // segment, only valid when the foot is between the endpoints (so
          // we don't fight the endpoint snaps).
          const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
          const len2 = dx*dx + dy*dy;
          if (len2 > EPS) {
            const t = ((world.x - e.p1.x)*dx + (world.y - e.p1.y)*dy) / len2;
            if (t > 0.05 && t < 0.95) {
              consider({ x: e.p1.x + t*dx, y: e.p1.y + t*dy }, 'on-line', e);
            }
          }
        } else if (e instanceof Circle) {
          consider(e.center, 'center', e);
          consider({ x:e.center.x+e.r, y:e.center.y }, 'quadrant', e);
          consider({ x:e.center.x-e.r, y:e.center.y }, 'quadrant', e);
          consider({ x:e.center.x, y:e.center.y+e.r }, 'quadrant', e);
          consider({ x:e.center.x, y:e.center.y-e.r }, 'quadrant', e);
          // On-circle snap: nearest point on the perimeter.
          const cdx = world.x - e.center.x, cdy = world.y - e.center.y;
          const cd  = Math.hypot(cdx, cdy);
          if (cd > EPS) {
            consider({ x: e.center.x + cdx/cd * e.r, y: e.center.y + cdy/cd * e.r }, 'on-circle', e);
          }
        } else if (e instanceof Arc) {
          e.syncEnds();
          consider(e.center, 'center', e);
          consider(e.start,  'endpoint', e.start);
          consider(e.end,    'endpoint', e.end);
          // On-arc: nearest point on the arc, but only if the angle to the
          // cursor lies within [a0, a1].
          const adx = world.x - e.center.x, ady = world.y - e.center.y;
          const ad  = Math.hypot(adx, ady);
          if (ad > EPS) {
            const theta = Math.atan2(ady, adx);
            if (angleOnDirectedArc(theta, e.a0, e.a1, e.clockwise)) {
              consider({ x: e.center.x + adx/ad * e.r, y: e.center.y + ady/ad * e.r }, 'on-circle', e);
            }
          }
        } else if (e instanceof Point) {
          consider(e, 'endpoint', e);
        }
      }
    }
    consider({ x:0, y:0 }, 'origin', null);
    return best;
  }
}

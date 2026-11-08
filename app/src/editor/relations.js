import { Arc, Circle, Line, Point } from '../core/entities.js';
import { CONSTRAINT_GLYPHS } from '../core/constraints.js';

/* =============== 9. AVAILABLE-CONSTRAINTS ENGINE ================ */
export function classifySelection(sel) {
  const points  = sel.filter(e => e instanceof Point);
  const lines   = sel.filter(e => e instanceof Line);
  const circles = sel.filter(e => e instanceof Circle);
  const arcs    = sel.filter(e => e instanceof Arc);
  return { points, lines, circles, arcs, total: sel.length };
}

export function sameLineRefs(line, ref) {
  if (!line || !ref) return false;
  return (ref.a === line.p1.id && ref.b === line.p2.id) ||
         (ref.a === line.p2.id && ref.b === line.p1.id);
}

export function constraintAppliesToSelection(c, sel) {
  if (c.kind === 'directedAngle') return false;              // internal regular-polygon scaffold
  if (c.kind === 'equalLength' && c.driven) return false;    // informational polygon equality marker

  const refs = new Set(c.refs());
  const selectedPoints = new Set(sel.filter(e => e instanceof Point).map(e => e.id));
  const selectedLines = sel.filter(e => e instanceof Line);
  const selectedCurves = sel.filter(e => e instanceof Circle || e instanceof Arc);
  const hasLine = (ref) => selectedLines.some(l => sameLineRefs(l, ref));
  const selectedLineOwnsBothPoints = (line) =>
    selectedPoints.has(line.p1.id) && selectedPoints.has(line.p2.id);

  for (const e of sel) {
    if (e instanceof Point) {
      const arcRef = (e.arcOwner instanceof Arc && (e.arcEndpoint === 'start' || e.arcEndpoint === 'end'))
        ? { arcId:e.arcOwner.id, centerId:e.arcOwner.center.id, which:e.arcEndpoint }
        : null;
      const sameArcRef = (r) => arcRef && r && r.arcId === arcRef.arcId && r.centerId === arcRef.centerId && r.which === arcRef.which;
      if (c.kind === 'fix') return c.pointId === e.id;
      if (c.kind === 'arcEndpointFix') return sameArcRef(c.ref);
      if (c.kind === 'coincident') return c.p1 === e.id || c.p2 === e.id;
      if (c.kind === 'arcEndpointCoincident') return c.pointId === e.id || sameArcRef(c.ref);
      if (c.kind === 'arcEndpointArcEndpointCoincident') return sameArcRef(c.ref1) || sameArcRef(c.ref2);
      if (c.kind === 'pointRefHorizontal' || c.kind === 'pointRefVertical') {
        return c.ref1.pointId === e.id || c.ref2.pointId === e.id || sameArcRef(c.ref1) || sameArcRef(c.ref2);
      }
      if (c.kind === 'distance') return c.p1 === e.id || c.p2 === e.id;
      if (c.kind === 'curveDistance') return c.c1 === e.id || c.c2 === e.id;
      if (c.kind === 'pointLineDistance') return c.pointId === e.id;
      if (c.kind === 'offsetDistance') return c.pairs && c.pairs.some(p => p.kind === 'line' ? p.pointId === e.id : false);
      if (c.kind === 'midpoint') return c.pointId === e.id;
      if (c.kind === 'arcEndpointMidpoint') return sameArcRef(c.ref);
      if (c.kind === 'pointOnLine') return c.pointId === e.id;
      if (c.kind === 'arcEndpointOnLine') return sameArcRef(c.ref);
      if (c.kind === 'pointOnCircle') return c.pointId === e.id;
      if (c.kind === 'arcEndpointOnCircle') return sameArcRef(c.ref);
      if (c.kind === 'concentric') return c.p1 === e.id || c.p2 === e.id;
      if (c.kind === 'symmetric') return c.p1 === e.id || c.p2 === e.id;
      if ((c.kind === 'horizontal' || c.kind === 'vertical') &&
          selectedPoints.has(c.p1) && selectedPoints.has(c.p2)) return true;
    } else if (e instanceof Line) {
      if (refs.has(e.id)) return true;
      if ((c.kind === 'horizontal' || c.kind === 'vertical')) {
        if (c.lineId === e.id) return true;
        continue;
      }
      if (c.kind === 'parallel' || c.kind === 'perpendicular' ||
          c.kind === 'collinear' || c.kind === 'equalLength') {
        if (sameLineRefs(e, c.l1) || sameLineRefs(e, c.l2)) return true;
        continue;
      }
      if (c.kind === 'angle') {
        if (sameLineRefs(e, c.l1) || sameLineRefs(e, c.l2)) return true;
        continue;
      }
      if (c.kind === 'pointOnLine' || c.kind === 'pointLineDistance' || c.kind === 'midpoint') {
        if (sameLineRefs(e, c.l)) return true;
        continue;
      }
      if (c.kind === 'offset' && (c.sourceEntityId === e.id || c.targetEntityId === e.id)) return true;
      if (c.kind === 'offsetDistance' && c.pairs && c.pairs.some(p => p.kind === 'line' && sameLineRefs(e, p.l))) return true;
      if (c.kind === 'symmetric' && sameLineRefs(e, c.axis)) return true;
      if (c.kind === 'distance' && refs.has(e.p1.id) && refs.has(e.p2.id)) return true;
      if (c.kind === 'fix' && (c.pointId === e.p1.id || c.pointId === e.p2.id)) return true;
      if (c.kind === 'coincident' && (refs.has(e.p1.id) || refs.has(e.p2.id))) return true;
    } else if (e instanceof Circle || e instanceof Arc) {
      if (refs.has(e.id) || refs.has(e.center.id)) return true;
    }
  }

  if ((c.kind === 'parallel' || c.kind === 'perpendicular' ||
       c.kind === 'collinear' || c.kind === 'equalLength' || c.kind === 'angle') &&
      (hasLine(c.l1) || hasLine(c.l2))) return true;
  if ((c.kind === 'pointOnLine' || c.kind === 'pointLineDistance' || c.kind === 'midpoint') &&
      hasLine(c.l)) return true;
  if ((c.kind === 'horizontal' || c.kind === 'vertical')) {
    for (const l of selectedLines) if (c.lineId === l.id || selectedLineOwnsBothPoints(l)) return true;
  }
  if (c.kind === 'symmetric' && hasLine(c.axis)) return true;
  if (selectedCurves.length) {
    for (const e of selectedCurves) {
      if (c.kind === 'radius' && c.circleId === e.id) return true;
      if (c.kind === 'curveDistance' && (c.c1 === e.id || c.c2 === e.id)) return true;
      if (c.kind === 'offset' && (c.sourceEntityId === e.id || c.targetEntityId === e.id)) return true;
      if (c.kind === 'offsetDistance' && c.pairs && c.pairs.some(p => p.c1 === e.id || p.c2 === e.id)) return true;
      if (c.kind === 'equalRadius' && (c.c1 === e.id || c.c2 === e.id)) return true;
      if (c.kind === 'pointOnCircle' && c.circleId === e.id) return true;
      if (c.kind === 'concentric' && (c.p1 === e.center.id || c.p2 === e.center.id)) return true;
      if (c.kind === 'tangent' && (c.circleId === e.id || c.c1 === e.id || c.c2 === e.id)) return true;
    }
  }
  return false;
}

export function availableRelations(sel) {
  const { points, lines, circles, arcs, total } = classifySelection(sel);
  const out = [];
  const push = (kind, label) => out.push({ kind, label, glyph: CONSTRAINT_GLYPHS[kind] || '' });

  if (total === 0) return out;

  // Single line: H, V, fix
  if (total === 1 && lines.length === 1) {
    push('horizontal', 'Horizontal');
    push('vertical', 'Vertical');
    push('fix', 'Fix');
    return out;
  }
  // Single circle/arc: fix
  if (total === 1 && (circles.length === 1 || arcs.length === 1)) {
    push('fix', 'Fix');
    return out;
  }
  // Single point: fix
  if (total === 1 && points.length === 1) {
    push('fix', 'Fix');
    return out;
  }
  // ≥2 points only
  if (points.length === total && total >= 2) {
    push('coincident', 'Coincident');
    push('horizontal', 'Horizontal');
    push('vertical', 'Vertical');
    push('fix', 'Fix');
    return out;
  }
  // ≥2 lines only
  if (lines.length === total && lines.length >= 2) {
    push('parallel', 'Parallel');
    push('perpendicular', 'Perpendicular');
    push('collinear', 'Collinear');
    push('equalLength', 'Equal length');
    push('horizontal', 'Horizontal');
    push('vertical', 'Vertical');
    push('fix', 'Fix');
    return out;
  }
  // ≥2 circles/arcs only
  if ((circles.length + arcs.length) === total && (circles.length + arcs.length) >= 2) {
    push('equalRadius', 'Equal radius');
    push('concentric', 'Concentric');
    push('tangent', 'Tangent');
    push('fix', 'Fix');
    return out;
  }
  // 1 line + ≥1 points
  if (lines.length === 1 && points.length >= 1 && circles.length + arcs.length === 0) {
    push('pointOnLine', 'On line');
    if (points.length === 1) push('midpoint', 'Midpoint');
    return out;
  }
  // 1 circle/arc + ≥1 points
  if ((circles.length + arcs.length) === 1 && points.length >= 1 && lines.length === 0) {
    push('pointOnCircle', 'On circle');
    return out;
  }
  // 1 line + 1 circle/arc
  if (lines.length === 1 && (circles.length + arcs.length) === 1 && points.length === 0) {
    push('tangent', 'Tangent');
    return out;
  }
  // mixed fallback
  if (points.length >= 2) push('coincident', 'Coincident');
  if (lines.length >= 2) {
    push('parallel', 'Parallel');
    push('perpendicular', 'Perpendicular');
    push('equalLength', 'Equal length');
  }
  if (circles.length + arcs.length >= 2) push('equalRadius', 'Equal radius');
  push('fix', 'Fix');
  return out;
}

export function availableDimensions(sel) {
  const { points, lines, circles, arcs, total } = classifySelection(sel);
  const out = [];
  const push = (kind, label) => out.push({ kind, label, glyph: CONSTRAINT_GLYPHS[kind] || '' });

  if (total === 1 && lines.length === 1)        push('distance', 'Length');
  if (total === 1 && circles.length === 1)    { push('diameter', 'Diameter'); push('radius', 'Radius'); }
  if (total === 1 && arcs.length === 1)         push('radius', 'Radius');
  if (total === 2 && points.length === 2)       push('distance', 'Distance');
  if (total === 2 && lines.length === 2)        push('angle', 'Angle');
  if (total === 2 && lines.length === 1 && points.length === 1)
    push('pointLineDistance', 'Pt → line dist');
  return out;
}

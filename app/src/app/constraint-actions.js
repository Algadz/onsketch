import { Circle, Line } from '../core/entities.js';
import { CollinearConstraint, ConcentricConstraint, Constraint, constraintLabel, EqualLengthConstraint, EqualRadiusConstraint, HorizontalConstraint, ParallelConstraint, PerpendicularConstraint, TangentCircleCircleConstraint, TangentLineCircleConstraint, VerticalConstraint } from '../core/constraints.js';
import { classifySelection } from '../editor/relations.js';
import { confirmDialog } from '../ui/dialogs.js';

/** Constraint kinds that express the same relation (plain points vs arc
 *  endpoints), keyed by the relation the Properties buttons offer. */
export const RELATION_FAMILY = {
  fix: ['fix', 'arcEndpointFix'],
  coincident: ['coincident', 'arcEndpointCoincident', 'arcEndpointArcEndpointCoincident'],
  horizontal: ['horizontal', 'pointRefHorizontal'],
  vertical: ['vertical', 'pointRefVertical'],
  midpoint: ['midpoint', 'arcEndpointMidpoint'],
  pointOnLine: ['pointOnLine', 'arcEndpointOnLine'],
  pointOnCircle: ['pointOnCircle', 'arcEndpointOnCircle'],
  parallel: ['parallel'], perpendicular: ['perpendicular'], collinear: ['collinear'],
  equalLength: ['equalLength'], equalRadius: ['equalRadius'], concentric: ['concentric'],
  tangent: ['tangent'],
};
const FAMILY_OF = new Map(Object.entries(RELATION_FAMILY).flatMap(([f, ks]) => ks.map(k => [k, f])));
export const relationFamily = (kind) => FAMILY_OF.get(kind) || kind;

export class ConstraintActionsMixin {

  /** Ids a constraint really ties: arc-endpoint refs resolve to the endpoint
   *  point, and ids that name nothing (virtual H/V lines) are dropped. */
  _relationRefIds(c, byId = this._lookupMap([this.activeSketch()].filter(Boolean))) {
    const out = new Set(c.refs());
    for (const r of [c.ref, c.ref1, c.ref2]) {
      if (!r) continue;
      if (r.arcId) {
        out.delete(r.arcId); out.delete(r.centerId);
        const p = byId.get(r.arcId)?.[r.which];
        if (p) out.add(p.id);
      }
      if (r.pointId) out.add(r.pointId);
    }
    for (const id of [...out]) if (!byId.has(id)) out.delete(id);
    return out;
  }

  /** Whether two constraints state the same relation between the same things. */
  _sameRelation(a, b, byId) {
    if (relationFamily(a.kind) !== relationFamily(b.kind)) return false;
    const ra = this._relationRefIds(a, byId), rb = this._relationRefIds(b, byId);
    if (ra.size !== rb.size) return false;
    for (const id of ra) if (!rb.has(id)) return false;
    return true;
  }

  /**
   * What `kind` would add for the selection. Constraints that already hold
   * (the same relation exists, or a chain of them implies it) are counted
   * in `held` instead, so a relation can never be applied twice.
   * @returns {{add: Constraint[], held: number}}
   */
  _relationCandidates(kind, sel = this.selectedEntitiesAndPoints(), sketch = this.activeSketch()) {
    const add = [];
    let held = 0;
    if (!sketch) return { add, held };
    const byId = this._lookupMap([sketch]);
    const { points, lines, circles, arcs } = classifySelection(sel);
    const consider = (c) => {
      if (!c || this._isInvalidConstraint(sketch, c)) return;
      if ([...sketch.constraints, ...add].some(ex => this._sameRelation(ex, c, byId))) { held++; return; }
      add.push(c);
    };
    // Union-find over an existing transitive relation (parallel, equal…).
    const groups = (ids, pairsOf) => {
      const parent = new Map(ids.map(id => [id, id]));
      const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
      for (const [a, b] of pairsOf) union(a, b);
      return { find, union };
    };

    switch (kind) {
      case 'fix': {
        const pts = [...points, ...lines.flatMap(l => [l.p1, l.p2]), ...circles.map(c => c.center), ...arcs.map(a => a.center)];
        for (const p of new Set(pts)) consider(this._fixConstraintForPoint(p));
        break;
      }
      case 'coincident':
        for (let i = 1; i < points.length; i++) {
          if (!this.arcEndpointRef(points[0]) && !this.arcEndpointRef(points[i]) &&
              this.pointsCoincidentInSketch(sketch, points[0], points[i])) { held++; continue; }
          consider(this._coincidentConstraintForPoints(points[0], points[i]));
        }
        break;
      case 'horizontal':
      case 'vertical': {
        const C = kind === 'horizontal' ? HorizontalConstraint : VerticalConstraint;
        for (const l of lines) consider(new C(l.id, l.p1.id, l.p2.id));
        if (points.length === 2) consider(this._axisConstraintForPoints(kind, points[0], points[1]));
        break;
      }
      case 'parallel':
      case 'perpendicular':
      case 'collinear':
      case 'equalLength': {
        const C = { parallel:ParallelConstraint, perpendicular:PerpendicularConstraint,
                    collinear:CollinearConstraint, equalLength:EqualLengthConstraint }[kind];
        // Transitive relations tie every pick to the FIRST selected line and
        // skip pairs already linked through a chain. Perpendicular is not
        // transitive: only an identical relation counts as held.
        const lineByPair = new Map();
        for (const e of sketch.entities) if (e instanceof Line) {
          lineByPair.set(e.p1.id + '|' + e.p2.id, e.id);
          lineByPair.set(e.p2.id + '|' + e.p1.id, e.id);
        }
        const pairs = kind === 'perpendicular' ? [] : sketch.constraints
          .filter(c => c.kind === kind)
          .map(c => [lineByPair.get(c.l1.a + '|' + c.l1.b), lineByPair.get(c.l2.a + '|' + c.l2.b)])
          .filter(([a, b]) => a && b);
        const g = groups(lines.map(l => l.id), pairs);
        for (let i = 1; i < lines.length; i++) {
          if (kind !== 'perpendicular' && g.find(lines[0].id) === g.find(lines[i].id)) { held++; continue; }
          consider(new C({ a: lines[0].p1.id, b: lines[0].p2.id }, { a: lines[i].p1.id, b: lines[i].p2.id }));
          if (kind !== 'perpendicular') g.union(lines[0].id, lines[i].id);
        }
        break;
      }
      case 'equal':
        if (circles.length + arcs.length < 2) return lines.length >= 2 ? this._relationCandidates('equalLength', sel, sketch) : { add, held };
        // falls through
      case 'equalRadius': {
        const all = [...circles, ...arcs];
        const g = groups(all.map(e => e.id), sketch.constraints.filter(c => c.kind === 'equalRadius').map(c => [c.c1, c.c2]));
        for (let i = 1; i < all.length; i++) {
          if (g.find(all[0].id) === g.find(all[i].id)) { held++; continue; }
          consider(new EqualRadiusConstraint(all[0].id, all[i].id));
          g.union(all[0].id, all[i].id);
        }
        break;
      }
      case 'concentric': {
        const all = [...circles, ...arcs];
        const g = groups(all.map(e => e.center.id), sketch.constraints.filter(c => c.kind === 'concentric').map(c => [c.p1, c.p2]));
        for (let i = 1; i < all.length; i++) {
          if (g.find(all[0].center.id) === g.find(all[i].center.id)) { held++; continue; }
          consider(new ConcentricConstraint(all[0].center.id, all[i].center.id));
          g.union(all[0].center.id, all[i].center.id);
        }
        break;
      }
      case 'tangent': {
        const curves = [...circles, ...arcs];
        if (lines.length === 1 && curves.length === 1 && points.length === 0) {
          const l = lines[0], c = curves[0];
          consider(new TangentLineCircleConstraint({ a:l.p1.id, b:l.p2.id }, c.id, c.center.id));
        } else if (curves.length === 2 && lines.length === 0) {
          consider(new TangentCircleCircleConstraint(curves[0].id, curves[0].center.id, curves[1].id, curves[1].center.id, false));
        }
        break;
      }
      case 'midpoint':
        if (lines.length === 1 && points.length === 1) consider(this._midpointConstraintForPoint(points[0], lines[0]));
        break;
      case 'pointOnLine':
        if (lines.length === 1) for (const p of points) consider(this._pointOnLineConstraintForPoint(p, lines[0]));
        break;
      case 'pointOnCircle':
        if (circles.length + arcs.length === 1) for (const p of points) consider(this._pointOnCircleConstraintForPoint(p, circles[0] || arcs[0]));
        break;
    }
    return { add, held };
  }

  /** Relations of this kind directly between selected items (what
   *  "remove" takes away). A selected shape counts with its own points. */
  _directRelations(kind, sel = this.selectedEntitiesAndPoints(), sketch = this.activeSketch()) {
    if (!sketch) return [];
    const family = relationFamily(kind === 'equal' ? 'equalRadius' : kind);
    const ids = new Set();
    for (const e of sel) {
      if (e instanceof Constraint) continue;
      ids.add(e.id);
      if (e.children) for (const ch of e.children()) ids.add(ch.id);
    }
    const byId = this._lookupMap([sketch]);
    return sketch.constraints.filter(c => {
      if (relationFamily(c.kind) !== family) return false;
      const refs = this._relationRefIds(c, byId);
      return refs.size > 0 && [...refs].every(id => ids.has(id));
    });
  }

  /** 'on' (already holds; `removable` when the selection carries it
   *  itself), 'partial' (holds for some picks), 'off', or 'na'. */
  relationState(kind, sel = this.selectedEntitiesAndPoints()) {
    const { add, held } = this._relationCandidates(kind, sel);
    const direct = this._directRelations(kind, sel);
    if (!add.length) return held ? { state: 'on', removable: direct.length > 0 } : { state: 'na', removable: false };
    return { state: held || direct.length ? 'partial' : 'off', removable: direct.length > 0 };
  }

  /** Properties button: apply the relation, or take it off when it is
   *  already fully applied by the selection itself. */
  toggleRelation(kind) {
    const { state, removable } = this.relationState(kind);
    if (state === 'on') {
      if (removable) this.removeRelation(kind);
      else this._hint(`${constraintLabel({ kind })} already holds through other relations.`);
      return;
    }
    this.applyConstraint(kind);
  }

  removeRelation(kind) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const gone = new Set(this._directRelations(kind));
    if (!gone.size) return;
    sketch.constraints = sketch.constraints.filter(c => !gone.has(c));
    this._syncFixFlags([], [...gone]);
    this.commit();
    this.refreshUI();
  }

  _hint(text) {
    const el = document.getElementById('status-hint');
    if (el) el.textContent = text;
  }

  /** Keep Point.fixed (what dragging honours) in step with Fix
   *  relations: set for added ones, cleared for removed ones unless another
   *  Fix still holds the point. Points pinned without a relation stay. */
  _syncFixFlags(added = [], removed = []) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const byId = this._lookupMap([sketch]);
    for (const c of added) if (c.kind === 'fix') { const p = byId.get(c.pointId); if (p) p.fixed = true; }
    for (const c of removed) {
      if (c.kind !== 'fix' || sketch.constraints.some(k => k.kind === 'fix' && k.pointId === c.pointId)) continue;
      const p = byId.get(c.pointId); if (p) p.fixed = false;
    }
  }

  /* ---- Constraint application ---- */
  applyConstraint(kind) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const sel = this.selectedEntitiesAndPoints();
    const { add } = this._relationCandidates(kind, sel, sketch);
    if (!add.length) {
      this._hint(`${constraintLabel({ kind })} is already applied to this selection.`);
      return;
    }

    const beforeJSON = JSON.stringify(this.project.toJSON({ images: false }));
    const beforeState = this._captureSketchParams(sketch);
    const beforeGraph = this._buildConstraintGraph(sketch, { skipKinds: this._dragJointConstraintKinds() });
    sketch.constraints.push(...add);
    this._syncFixFlags(add);
    if (kind !== 'fix' && sel.length >= 2) {
      this._solveWithFirstSelectionMoving(sketch, sel, beforeState, beforeGraph);
    }
    const affectedIds = new Set();
    for (const item of sel) {
      if (!item?.id) continue;
      affectedIds.add(item.id);
      if (item.children) for (const child of item.children()) affectedIds.add(child.id);
    }
    this.commit({ activeIds: affectedIds });
    this.refreshUI();
    // If the new constraint(s) made things impossible to solve, warn.
    const solver = this.solver.solve(sketch, this.project.sketches, [], {
      diagnostics:true,
      activeIds:affectedIds
    });
    if (solver.state === 'over' && solver.residual > 1e-2) {
      confirmDialog({
        title: 'This relation over-defines the sketch',
        message: `The shapes can't satisfy all their relations and dimensions with it (residual ${solver.residual.toExponential(2)}). Keep it anyway? Over-defined shapes turn red.`,
        confirmLabel: 'Keep it', cancelLabel: 'Remove it',
      }).then(keep => {
        if (keep) return;
        this._swapSameDocument(beforeJSON);
        this.selectionOrder = [];
        this.solveAndRender();
        this.refreshUI();
      });
    }
  }

  applyDimension(kind) {
    // Route sidebar dimension buttons through the SmartDim tool: copy the
    // current selection in as picks, infer the preview, override the kind
    // when the button is more specific than the default inference (e.g.
    // "Radius" on a Circle that would default to Diameter), then enter
    // the placing phase so the user clicks once to place + types value.
    const sketch = this.activeSketch();
    const sel = this.selectedEntitiesAndPoints();
    if (!sketch || !sel.length) return;
    this.setTool('smartdim');
    this.tool.picks = sel.slice();
    if (!this.tool._inferPreview()) return;
    const p = this.tool.preview;
    if (kind === 'radius' && p.kind === 'diameter') {
      p.kind = 'radius';
      p.value = p.circle.r;
    } else if (kind === 'diameter' && p.kind === 'radius' && p.circle instanceof Circle) {
      p.kind = 'diameter';
      p.value = p.circle.r * 2;
    }
    this.tool.phase = 'placing';
    this.tool._updateCursorPlacement(this.lastWorldCursor);
    this.requestRender();
  }
}

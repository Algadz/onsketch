import { Arc, Circle, Line } from '../core/entities.js';
import { CollinearConstraint, ConcentricConstraint, EqualLengthConstraint, EqualRadiusConstraint, FixConstraint, HorizontalConstraint, ParallelConstraint, PerpendicularConstraint, TangentCircleCircleConstraint, TangentLineCircleConstraint, VerticalConstraint } from '../core/constraints.js';
import { Project } from '../core/model.js';
import { classifySelection } from '../editor/relations.js';

export class ConstraintActionsMixin {

  /* ---- Constraint application ---- */
  applyConstraint(kind) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const sel = this.selectedEntitiesAndPoints();
    const { points, lines, circles, arcs } = classifySelection(sel);

    const beforeJSON = JSON.stringify(this.project.toJSON());
    const beforeState = this._captureSketchParams(sketch);
    const beforeGraph = this._buildConstraintGraph(sketch, { skipKinds: this._dragJointConstraintKinds() });
    const tryAdd = (cons) => {
      const list = Array.isArray(cons) ? cons : [cons];
      for (const c of list) {
        if (!this._isInvalidConstraint(sketch, c)) sketch.constraints.push(c);
      }
    };

    let added = false;
    switch (kind) {
      case 'fix':
        for (const p of points) {
          tryAdd(this._fixConstraintForPoint(p));
          if (!this.arcEndpointRef(p)) p.fixed = true;
          added = true;
        }
        for (const e of lines)  for (const p of [e.p1,e.p2]) { tryAdd(new FixConstraint(p.id, p.x, p.y)); p.fixed = true; added = true; }
        for (const c of circles){ tryAdd(new FixConstraint(c.center.id, c.center.x, c.center.y)); c.center.fixed = true; added = true; }
        for (const a of arcs)   { tryAdd(new FixConstraint(a.center.id, a.center.x, a.center.y)); a.center.fixed = true; added = true; }
        break;
      case 'coincident':
        for (let i = 1; i < points.length; i++) { tryAdd(this._coincidentConstraintForPoints(points[0], points[i])); added = true; }
        break;
      case 'horizontal':
      case 'vertical': {
        const C = kind === 'horizontal' ? HorizontalConstraint : VerticalConstraint;
        for (const l of lines) { tryAdd(new C(l.id, l.p1.id, l.p2.id)); added = true; }
        if (points.length === 2) {
          tryAdd(this._axisConstraintForPoints(kind, points[0], points[1])); added = true;
        }
        break;
      }
      case 'parallel':
      case 'perpendicular':
      case 'collinear':
      case 'equalLength': {
        const C = { parallel:ParallelConstraint, perpendicular:PerpendicularConstraint,
                    collinear:CollinearConstraint, equalLength:EqualLengthConstraint }[kind];
        // For transitive relations (parallel, collinear, equalLength) avoid
        // adding pairs that are already linked through the existing
        // constraint graph. The relation is added with the FIRST selected
        // entity as the anchor — i.e. all subsequent picks are tied to
        // lines[0]. Perpendicular is NOT transitive, so we always add.
        const transitive = (kind !== 'perpendicular');
        const lineByPair = new Map();
        for (const e of sketch.entities) if (e instanceof Line) {
          lineByPair.set(e.p1.id+'|'+e.p2.id, e);
          lineByPair.set(e.p2.id+'|'+e.p1.id, e);
        }
        const parent = new Map();
        const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        const union = (a, b) => { const ra=find(a), rb=find(b); if (ra !== rb) parent.set(ra, rb); };
        if (transitive) {
          for (const e of sketch.entities) if (e instanceof Line) parent.set(e.id, e.id);
          for (const c of sketch.constraints) {
            if (c.kind !== kind) continue;
            const lA = lineByPair.get(c.l1.a+'|'+c.l1.b);
            const lB = lineByPair.get(c.l2.a+'|'+c.l2.b);
            if (lA && lB) union(lA.id, lB.id);
          }
        }
        for (let i = 1; i < lines.length; i++) {
          if (transitive && find(lines[0].id) === find(lines[i].id)) continue; // already linked
          tryAdd(new C(
            { a: lines[0].p1.id, b: lines[0].p2.id },
            { a: lines[i].p1.id, b: lines[i].p2.id }
          ));
          if (transitive) union(lines[0].id, lines[i].id);
          added = true;
        }
        break;
      }
      case 'equalRadius':
      case 'equal': {
        const all = [...circles, ...arcs];
        if (all.length >= 2) {
          // skip duplicates via union-find of existing equalRadius graph
          const parent = new Map();
          for (const e of [...circles, ...arcs]) parent.set(e.id, e.id);
          for (const e of sketch.entities) if (e instanceof Circle || e instanceof Arc) parent.set(e.id, e.id);
          const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
          const union = (a,b) => { const ra=find(a), rb=find(b); if (ra!==rb) parent.set(ra, rb); };
          for (const c of sketch.constraints) if (c.kind === 'equalRadius') union(c.c1, c.c2);
          for (let i = 1; i < all.length; i++) {
            if (find(all[0].id) === find(all[i].id)) continue;
            tryAdd(new EqualRadiusConstraint(all[0].id, all[i].id));
            union(all[0].id, all[i].id);
            added = true;
          }
        } else if (lines.length >= 2) {
          // fall through to equalLength behaviour
          this.applyConstraint('equalLength');
          return;
        }
        break;
      }
      case 'concentric': {
        const all = [...circles, ...arcs];
        if (all.length >= 2) {
          const parent = new Map();
          for (const e of all) parent.set(e.center.id, e.center.id);
          const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
          const union = (a,b) => { const ra=find(a), rb=find(b); if (ra!==rb) parent.set(ra, rb); };
          for (const c of sketch.constraints) if (c.kind === 'concentric') union(c.p1, c.p2);
          for (let i = 1; i < all.length; i++) {
            if (find(all[0].center.id) === find(all[i].center.id)) continue;
            tryAdd(new ConcentricConstraint(all[0].center.id, all[i].center.id));
            union(all[0].center.id, all[i].center.id);
            added = true;
          }
        }
        break;
      }
      case 'tangent': {
        if (lines.length === 1 && (circles.length + arcs.length) === 1) {
          const l = lines[0], c = circles[0] || arcs[0];
          tryAdd(new TangentLineCircleConstraint({a:l.p1.id, b:l.p2.id}, c.id, c.center.id));
          added = true;
        } else if ((circles.length + arcs.length) === 2 && lines.length === 0) {
          const a = circles[0] || arcs[0];
          const b = circles[1] || arcs[circles.length === 0 ? 1 : 0] || arcs[0];
          tryAdd(new TangentCircleCircleConstraint(a.id, a.center.id, b.id, b.center.id, false));
          added = true;
        }
        break;
      }
      case 'midpoint': {
        if (lines.length === 1 && points.length === 1) {
          tryAdd(this._midpointConstraintForPoint(points[0], lines[0]));
          added = true;
        }
        break;
      }
      case 'pointOnLine': {
        if (lines.length === 1 && points.length >= 1) {
          for (const p of points) tryAdd(this._pointOnLineConstraintForPoint(p, lines[0]));
          added = true;
        }
        break;
      }
      case 'pointOnCircle': {
        if ((circles.length + arcs.length) === 1 && points.length >= 1) {
          const c = circles[0] || arcs[0];
          for (const p of points) tryAdd(this._pointOnCircleConstraintForPoint(p, c));
          added = true;
        }
        break;
      }
    }

    if (added) {
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
      // If the new constraint(s) made things impossible to solve, warn.
      const solver = this.solver.solve(sketch, this.project.sketches, [], {
        diagnostics:true,
        activeIds:affectedIds
      });
      if (solver.state === 'over' && solver.residual > 1e-2) {
        const msg = `This relation makes the sketch over-defined (residual ${solver.residual.toExponential(2)}). Keep it anyway?`;
        if (!confirm(msg)) {
          // revert
          this.project = Project.fromJSON(JSON.parse(beforeJSON));
          this.selectionOrder = [];
          this.solveAndRender();
          this.refreshUI();
        }
      }
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

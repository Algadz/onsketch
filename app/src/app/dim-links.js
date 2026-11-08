import { Arc, Circle, Line, Point } from '../core/entities.js';
import { DistanceConstraint, MidpointConstraint, RadiusConstraint } from '../core/constraints.js';
import { allDimensions, ensureDimensionNames } from '../core/equations.js';

/* =============== LINKED DIMENSIONS + FEATURE ACTIONS ===========
   Floating (driven) dimensions measure the geometry instead of driving
   it. Their value is re-measured before every render, solve and drag
   frame, so an equation can follow a shape you drag:

     1. edit D1, and while the value box is open click another line;
     2. that line's dimension name is inserted (=D5). If it had none, a
        floating dimension is created for it first;
     3. drag that line: D5 is re-measured, D1 = D5 is re-evaluated and
        D1's geometry follows live, while the dragged points stay put.

   Also the right-click actions on a shape: construction on / off, and
   "Create midpoint" on lines.
   ============================================================ */
export class DimLinksMixin {
  /** Re-measure every floating dimension from the geometry.
   *  @returns {boolean} whether any value changed */
  refreshDrivenDimensions() {
    const sketch = this.activeSketch(); if (!sketch) return false;
    const driven = sketch.constraints.filter(c => c.driven && c.value != null);
    if (!driven.length) return false;
    const byId = new Map();
    for (const e of sketch.entities) { byId.set(e.id, e); for (const ch of e.children()) byId.set(ch.id, ch); }
    let changed = false;
    for (const c of driven) {
      let v = null;
      if (c.kind === 'distance') {
        const a = byId.get(c.p1), b = byId.get(c.p2);
        if (a && b) v = Math.hypot(b.x - a.x, b.y - a.y);
      } else if (c.kind === 'radius') {
        const e = byId.get(c.circleId);
        if (e && Number.isFinite(e.r)) v = e.r;
      } else if (c.kind === 'pointLineDistance') {
        const p = byId.get(c.pointId), a = byId.get(c.l.a), b = byId.get(c.l.b);
        if (p && a && b) {
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
          if (len > 1e-12) v = Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / len;
        }
      }
      if (v != null && Math.abs(v - c.value) > 1e-9) { c.value = v; changed = true; }
    }
    return changed;
  }

  /** Name of the dimension that measures this shape: its existing length /
   *  radius dimension, or a new floating one. Null for anything else. */
  dimensionNameForEntity(e) {
    const sketch = this.activeSketch(); if (!sketch) return null;
    let c = null;
    if (e instanceof Line) {
      const ends = new Set([e.p1.id, e.p2.id]);
      c = sketch.constraints.find(k => k.kind === 'distance' && ends.has(k.p1) && ends.has(k.p2) && k.p1 !== k.p2);
      if (!c) {
        c = new DistanceConstraint(e.p1.id, e.p2.id, Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y));
        c.driven = true;
      }
    } else if (e instanceof Circle || e instanceof Arc) {
      c = sketch.constraints.find(k => k.kind === 'radius' && k.circleId === e.id);
      if (!c) {
        c = new RadiusConstraint(e.id, e.r);
        c.isDiameter = e instanceof Circle;
        c.driven = true;
      }
    }
    if (!c) return null;
    if (!sketch.constraints.includes(c)) {
      c.layerId = e.layerId || this.project.activeLayerId;
      sketch.constraints.push(c);
      ensureDimensionNames(this.project);
      this.requestRender();
    }
    return c.name;
  }

  /** Dimensions whose equation refers to a floating dimension. */
  _hasDrivenLinks() {
    const dims = allDimensions(this.project);
    const floating = dims.filter(c => c.driven && c.name).map(c => c.name);
    if (!floating.length) return false;
    const re = new RegExp(`\\b(${floating.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
    return dims.some(c => c.expr && !c.driven && re.test(c.expr))
      || (this.project.variables || []).some(v => re.test(v.expr || ''));
  }

  /** Called after each drag frame: if the drag changed a floating dimension
   *  that an equation uses, re-evaluate and move the linked geometry with
   *  the dragged points held where the cursor put them. */
  updateLinkedDimensionsDuringDrag(drag) {
    if (!drag || !this._hasDrivenLinks()) return;
    if (!this.refreshDrivenDimensions()) return;
    if (!this._applyEquations().changed) return;
    const sketch = this.activeSketch(); if (!sketch) return;
    const held = new Set();
    for (const r of [...(drag.pts || []), ...(drag.snapPts || [])]) if (r && r.p) held.add(r.p);
    if (drag.anchor?.p) held.add(drag.anchor.p);
    const was = new Map([...held].map(p => [p, p.locked]));
    for (const p of held) p.locked = true;
    try {
      this.solver.solve(sketch, this.project.sketches, [], { diagnostics: false, revertOnFailure: true });
      for (const e of sketch.entities) if (e.syncEnds) e.syncEnds();
    } finally {
      for (const [p, v] of was) p.locked = v;
    }
  }

  /* ---- Value box: click a shape to insert its dimension name ---- */

  /** Canvas click while a dimension value box is open. Returns true when
   *  the click was used to insert a name. */
  _valueInputPick(world) {
    const vi = this._valueInput; if (!vi) return false;
    const hits = this.hitTestAllSketches(world, this.activeVisibleSketches());
    const target = hits.find(e => e instanceof Line || e instanceof Circle || e instanceof Arc);
    if (!target) return false;
    const name = this.dimensionNameForEntity(target);
    if (!name) return false;
    if (vi.selfName && name === vi.selfName) {
      document.getElementById('status-hint').textContent = `${name} is the dimension you are editing.`;
      vi.hold();
      return true;
    }
    vi.insert(name);
    document.getElementById('status-hint').textContent = `Inserted ${name}. Enter to apply; drag that shape later and this dimension follows.`;
    return true;
  }

  /* ---- Right-click actions on a shape ---- */

  /** Shapes the right-click actions apply to: the selection when the
   *  clicked shape is part of it, else just the clicked shape. */
  _actionTargets(item) {
    const curves = (list) => list.filter(e => e instanceof Line || e instanceof Circle || e instanceof Arc);
    if (item && item.selected) {
      const sel = curves(this._selectedTopEntities());
      if (sel.length) return sel;
    }
    return item ? curves([item]) : [];
  }

  /** Context-menu actions for the shape under the cursor. */
  contextActions(items) {
    const owner = (e) => (e instanceof Point ? (this.project.ownerOf(e) || e) : e);
    const item = items.map(owner).find(e => e instanceof Line || e instanceof Circle || e instanceof Arc);
    if (!item) return [];
    const targets = this._actionTargets(item);
    const out = [];
    const allCons = targets.every(e => e.construction);
    const n = targets.length > 1 ? ` (${targets.length})` : '';
    out.push({
      id: 'construction',
      label: allCons ? `Set as normal geometry${n}` : `Set as construction${n}`,
      run: () => this.setConstruction(targets, !allCons),
    });
    if (this.touchUI) {
      const sel = this._selectionCount ? this._selectionCount() : 0;
      out.push({
        id: 'delete',
        label: item.selected && sel > 1 ? `Delete (${sel})` : 'Delete',
        run: () => {
          if (!item.selected) { this.clearSelection(); this.setSelected(item, true); }
          this.deleteSelection();
          this.refreshUI();
        },
      });
    }
    const lines = targets.filter(e => e instanceof Line);
    if (lines.length) {
      out.push({
        id: 'midpoint',
        label: lines.length > 1 ? `Create midpoints (${lines.length})` : 'Create midpoint',
        run: () => this.createMidpoints(lines),
      });
    }
    return out;
  }

  setConstruction(entities, on) {
    for (const e of entities) e.construction = !!on;
    this.commit();
    this.refreshUI();
    this.requestRender();
  }

  /** A point at the middle of each line, held there by a midpoint relation. */
  createMidpoints(lines) {
    const sketch = this.activeSketch(); if (!sketch) return [];
    const made = [];
    for (const l of lines) {
      const p = new Point((l.p1.x + l.p2.x) / 2, (l.p1.y + l.p2.y) / 2);
      p.layerId = l.layerId;
      sketch.addEntity(p);
      const c = new MidpointConstraint(p.id, { a: l.p1.id, b: l.p2.id });
      c.layerId = l.layerId;
      sketch.constraints.push(c);
      made.push(p);
    }
    this.commit({ activeIds: made.map(p => p.id) });
    this.refreshUI();
    this.requestRender();
    return made;
  }
}

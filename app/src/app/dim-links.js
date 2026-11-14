import { Arc, Bezier, Circle, Line, Point } from '../core/entities.js';
import { DistanceConstraint, MidpointConstraint, RadiusConstraint, constraintLabel } from '../core/constraints.js';
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
        if (a && b) v = c.axis === 'x' ? Math.abs(b.x - a.x) : c.axis === 'y' ? Math.abs(b.y - a.y) : Math.hypot(b.x - a.x, b.y - a.y);
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
      c = sketch.constraints.find(k => k.kind === 'distance' && !k.axis && ends.has(k.p1) && ends.has(k.p2) && k.p1 !== k.p2);
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

  /* ---- Writing an equation: click a dimension (or a shape) to insert its name ----
     While a formula is being typed (the value box on the canvas, an
     expression in the Equations window, or a dimension field in
     Properties), clicking a dimension's label inserts its name (D3) at
     the caret; clicking a line, circle or arc inserts the name of the
     dimension that measures it (a floating one is made if it has none).
     The field keeps the focus: Enter applies, as usual. Hovering shows a
     copy cursor and says what a click would insert. */

  /** Fields outside the canvas that take a formula. */
  _setupFormulaFields() {
    const FIELDS = '#equations-body .eq-expr, #sel-body input[data-dim-edit], #sb-body input[data-dim-edit], input.dim-val[data-dim-edit]';
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (el?.matches?.(FIELDS)) this._formulaField = el;
    });
    document.addEventListener('focusout', (e) => {
      if (e.target !== this._formulaField) return;
      // a canvas pick keeps the focus (see _formulaPick); anything else ends it
      setTimeout(() => { if (document.activeElement !== this._formulaField) this._formulaField = null; }, 0);
    });
    // Keep the field focused through a pick (mousedown would take it).
    this.canvas.addEventListener('mousedown', (e) => { if (this._keepFormulaFocus) { e.preventDefault(); this._keepFormulaFocus = false; } }, true);
  }

  /** The formula being typed, or null: { insert(name), selfName, kind }. */
  _formulaTarget() {
    if (this._valueInput) return { insert: (n) => this._valueInput.insert(n), hold: () => this._valueInput.hold(), selfName: this._valueInput.selfName };
    const el = this._formulaField;
    if (!el || !el.isConnected || document.activeElement !== el) return null;
    const dims = allDimensions(this.project);
    let selfName = null, equation = true;
    if (el.dataset.k === 'dim-expr') selfName = dims[+el.dataset.i]?.name || null;
    else if (el.dataset.k === 'var-expr') { selfName = (this.project.variables || [])[+el.dataset.i]?.name || null; equation = false; }
    else if (el.dataset.dimEdit) selfName = this.activeSketch()?.constraints.find(c => c.id === el.dataset.dimEdit)?.name || null;
    return {
      selfName,
      hold: () => setTimeout(() => el.focus(), 0),
      insert: (name) => {
        const v = el.value;
        const a = el.selectionStart ?? v.length, b = el.selectionEnd ?? v.length;
        let before = v.slice(0, a), after = v.slice(b);
        // A plain number (not an equation yet) is replaced by =name.
        if (equation && !/^\s*=/.test(v)) { before = '='; after = ''; }
        const pad = /[\w.)]\s*$/.test(before) ? ' + ' : '';
        el.value = before + pad + name + after;
        const caret = (before + pad + name).length;
        el.classList.remove('bad');
        setTimeout(() => { el.focus(); el.setSelectionRange(caret, caret); }, 0);
      },
    };
  }

  /** The name a click at this spot would insert while a formula is
   *  typed: a dimension label first, then a line, circle or arc. */
  _formulaCandidate(screen, world) {
    const dim = this.hitDimAtScreen(screen.x, screen.y);
    if (dim) { ensureDimensionNames(this.project); return { dim, name: dim.name }; }
    const hits = this.hitTestAllSketches(world, this.activeVisibleSketches());
    const shape = hits.find(e => e instanceof Line || e instanceof Circle || e instanceof Arc);
    return shape ? { shape } : null;
  }

  /** Canvas press while a formula is typed. Returns true when it was
   *  used to insert a name. */
  _formulaPick(screen, world) {
    const target = this._formulaTarget(); if (!target) return false;
    const hit = this._formulaCandidate(screen, world); if (!hit) return false;
    const name = hit.name || this.dimensionNameForEntity(hit.shape);
    if (!name) return false;
    this._keepFormulaFocus = true;
    if (target.selfName && name === target.selfName) {
      document.getElementById('status-hint').textContent = `${name} is the dimension you are editing.`;
      target.hold();
      return true;
    }
    target.insert(name);
    document.getElementById('status-hint').textContent = hit.dim
      ? `Inserted ${name}. Enter to apply.`
      : `Inserted ${name}. Enter to apply; drag that shape later and this dimension follows.`;
    return true;
  }

  /** Hover while a formula is typed: copy cursor and what a click inserts.
   *  @returns {boolean} whether it applied */
  _formulaHover(screen, world) {
    if (!this._formulaTarget()) {
      if (this._formulaHovering) { this._formulaHovering = false; this._updateCanvasCursor(); }
      return false;
    }
    this._formulaHovering = true;
    const hit = this._formulaCandidate(screen, world);
    this.canvas.style.cursor = hit ? 'copy' : '';
    const el = document.getElementById('status-hint');
    if (el) el.textContent = hit
      ? `Click to insert ${hit.name || 'this shape\'s dimension'} in the equation.`
      : 'Click a dimension (or a line, circle or arc) to insert its name in the equation.';
    return true;
  }

  /* ---- Right-click actions on a shape ---- */

  /** Shapes the right-click actions apply to: the selection when the
   *  clicked shape is part of it, else just the clicked shape. */
  _actionTargets(item) {
    const curves = (list) => list.filter(e => e instanceof Line || e instanceof Circle || e instanceof Arc || e instanceof Bezier);
    if (item && item.selected) {
      const sel = curves(this._selectedTopEntities());
      if (sel.length) return sel;
    }
    return item ? curves([item]) : [];
  }

  /** Context-menu actions for the shape under the cursor. */
  contextActions(items) {
    const owner = (e) => (e instanceof Point ? (this.project.ownerOf(e) || e) : e);
    const item = items.map(owner).find(e => e instanceof Line || e instanceof Circle || e instanceof Arc || e instanceof Bezier);
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
    for (const c of this.patternsOf?.([item]) || []) {
      out.push({ id: 'edit-pattern', label: `Edit ${constraintLabel(c).toLowerCase()}…`, run: () => this.editPattern(c) });
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

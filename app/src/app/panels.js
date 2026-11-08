import { evaluate } from '../core/expr.js';
import { dist, normalizeAngleValue } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { CONSTRAINT_LABELS, Constraint, FixConstraint } from '../core/constraints.js';
import { availableDimensions, availableRelations, constraintAppliesToSelection } from '../editor/relations.js';

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class PanelsMixin {

  /* ---- Sidebar ---- */
  _setupSidebar() {
    document.getElementById('project-name').addEventListener('input', (e) => {
      this.project.name = e.target.value;
    });
  }

  refreshUI() {
    this.refreshToolOptions();
    this._refreshSelectionPanel();
    this._refreshLayerPanel();
    this._refreshEquationsPanel();
    this._refreshColorsPanel();
    this._refreshSketchWindow();
    this._refreshOptionsBar();
    document.getElementById('project-name').value = this.project.name;
  }

  refreshToolOptions() {
    const section = document.getElementById('tool-options-section');
    const body = document.getElementById('tool-options-body');
    if (!section || !body) return;
    if (this.operationName === 'mirror') {
      this._refreshMirrorOptions(section, body);
      return;
    }
    if (this.operationName === 'offset') {
      this._refreshOffsetOptions(section, body);
      return;
    }
    section.hidden = true;
    body.innerHTML = '';
    document.getElementById('tool-options-title').textContent = 'Tool Options';
  }

  _refreshSelectionPanel() {
    const sel = this.selectedEntitiesAndPoints();
    const body = document.getElementById('sel-body');
    const ink = this.selectedStrokes();
    const count = sel.length + ink.length;
    document.getElementById('sel-count').textContent = count + (count === 1 ? ' item' : ' items');

    if (sel.length === 0 && ink.length) {
      body.innerHTML = this._inkSectionHTML(ink);
      this._bindInkSection(body);
      return;
    }
    if (sel.length === 0) {
      body.innerHTML = '<div class="empty">Click an entity to select. Ctrl-click to add or remove from selection.</div>';
      return;
    }

    const sketch = this.activeSketch();
    const hasConstraintSelection = sel.some(e => e instanceof Constraint);

    // ---- Selection list ----
    let html = '<div class="sb-subhead">Items</div>';
    for (const e of sel) {
      const owner = e instanceof Constraint ? null : this.project.ownerOf(e);
      const layer = owner ? this.project.layerOf(owner) : null;
      const glyph = e instanceof Point ? 'P' : e instanceof Line ? 'L' : e instanceof Circle ? 'C' : e instanceof Arc ? 'A' : '?';
      const kind  = e instanceof Constraint ? (CONSTRAINT_LABELS[e.kind] || e.kind) : e.constructor.kind;
      html += `<div class="sel-item">
                 <span class="glyph">${glyph}</span>
                 <span>${kind} ${e.id}</span>
                 <span class="layer-tag">${layer ? esc(layer.name) : '—'}</span>
               </div>`;
    }

    // ---- Add Relations ----
    const rels = hasConstraintSelection ? [] : availableRelations(sel);
    html += '<div class="sb-subhead">Add Relation</div>';
    if (rels.length === 0) {
      html += '<div class="empty">No relations apply to this selection.</div>';
    } else {
      html += '<div class="rel-grid">';
      for (const r of rels) {
        html += `<button class="rel-btn" data-rel="${r.kind}"><span class="glyph">${r.glyph}</span>${r.label}</button>`;
      }
      html += '</div>';
    }

    // ---- Add Dimension ----
    const dims = hasConstraintSelection ? [] : availableDimensions(sel);
    html += '<div class="sb-subhead">Add Dimension</div>';
    if (dims.length === 0) {
      html += '<div class="empty">No dimension applies. Use Smart Dim (D) or pick a different combo.</div>';
    } else {
      html += '<div class="rel-grid">';
      for (const d of dims) {
        html += `<button class="rel-btn" data-dim="${d.kind}"><span class="glyph">${d.glyph}</span>${d.label}</button>`;
      }
      html += '</div>';
    }

    // ---- Existing Relations on selection ----
    const related = (sketch?.constraints || []).filter(c => constraintAppliesToSelection(c, sel));
    html += '<div class="sb-subhead">Existing Relations</div>';
    if (related.length === 0) {
      html += '<div class="empty">None on selection.</div>';
    } else {
      html += '<div>';
      for (const c of related) {
        const label = CONSTRAINT_LABELS[c.kind] || c.kind;
        const valStr = (c.value !== null && c.value !== undefined) ? ` = ${Number(c.value).toFixed(3)}` : '';
        html += `<span class="constraint-pill" data-cid="${c.id}">${label}${valStr}<span class="x" data-cid="${c.id}">×</span></span>`;
      }
      html += '</div>';
    }

    // ---- Properties ----
    const e = sel[0];
    const constructionTargets = sel.filter(x => x instanceof Line || x instanceof Circle || x instanceof Arc);
    // Move the selected shapes (and their own relations) to another layer.
    const movable = sel.filter(e => !(e instanceof Constraint) && sketch.entities.includes(e));
    if (movable.length && this.project.layers.length > 1) {
      const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      html += `<div class="prop-row"><label>layer</label><select data-move-layer>
        ${[...this.project.layers].reverse().map(l => `<option value="${l.id}"${l.id === this.project.activeLayerId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select></div>`;
    }
    html += '<div class="sb-subhead">Properties</div>';
    if (sel.length > 1) {
      if (constructionTargets.length) {
        const allConstruction = constructionTargets.every(x => x.construction);
        html += `<div class="prop-row"><label>construction</label><input type="checkbox" data-toggle="construction-all" ${allConstruction?'checked':''}></div>`;
      } else {
        html += '<div class="empty">No shared properties.</div>';
      }
    } else if (e instanceof Point) {
      html += `<div class="prop-row"><label>x</label><input type="number" step="0.001" data-edit="x" value="${e.x.toFixed(4)}"></div>`;
      html += `<div class="prop-row"><label>y</label><input type="number" step="0.001" data-edit="y" value="${e.y.toFixed(4)}"></div>`;
      html += `<div class="prop-row"><label>fixed</label><input type="checkbox" data-toggle="fixed" ${e.fixed?'checked':''}></div>`;
    } else if (e instanceof Circle || e instanceof Arc) {
      html += `<div class="prop-row"><label>radius</label><input type="number" step="0.001" data-edit="r" value="${e.r.toFixed(4)}"></div>`;
      html += `<div class="prop-row"><label>construction</label><input type="checkbox" data-toggle="construction" ${e.construction?'checked':''}></div>`;
    } else if (e instanceof Line) {
      html += `<div class="prop-row"><label>length</label><span>${dist(e.p1,e.p2).toFixed(4)} ${this.project.units}</span></div>`;
      html += `<div class="prop-row"><label>construction</label><input type="checkbox" data-toggle="construction" ${e.construction?'checked':''}></div>`;
    } else if (e instanceof Constraint) {
      const val = e.kind === 'angle'
        ? (normalizeAngleValue(e.value) * 180 / Math.PI).toFixed(3) + '°'
        : (e.value != null ? Number(e.value).toFixed(3) : '');
      if (val) html += `<div class="prop-row"><label>value</label><span>${val}</span></div>`;
      if (['distance','pointLineDistance','radius','curveDistance','angle','offsetDistance'].includes(e.kind)) {
        html += `<div class="prop-row"><label>driven</label><span>${e.driven ? 'yes' : 'no'}</span></div>`;
      }
    }

    body.innerHTML = html + this._inkSectionHTML(ink);
    this._bindInkSection(body);
    const constructionAll = body.querySelector('input[data-toggle="construction-all"]');
    if (constructionAll) {
      constructionAll.indeterminate = constructionTargets.some(x => x.construction) &&
        !constructionTargets.every(x => x.construction);
    }

    const mover = body.querySelector('select[data-move-layer]');
    if (mover) mover.addEventListener('change', () => this.moveSelectionToLayer(mover.value));

    // Wire up buttons / inputs
    body.querySelectorAll('[data-rel]').forEach(b =>
      b.addEventListener('click', () => this.applyConstraint(b.dataset.rel)));
    body.querySelectorAll('[data-dim]').forEach(b =>
      b.addEventListener('click', () => this.applyDimension(b.dataset.dim)));
    body.querySelectorAll('input[data-edit]').forEach(inp => {
      inp.addEventListener('change', () => {
        const k = inp.dataset.edit;
        let v = NaN;
        try { v = evaluate(inp.value, (n) => this._namedValue(n)); } catch { /* ignore bad text */ }
        if (!Number.isFinite(v)) return;
        // Snap near-zero values back to exactly zero.
        e[k] = (Math.abs(v) < 1e-12) ? 0 : v;
        // If this Point is anchored by a Fix constraint, the constraint's
        // own (x,y) is the solver's target. Update it so the typed value
        // sticks instead of being pulled back to the old fix.
        if (e instanceof Point) {
          const fc = sketch.constraints.find(c => c.kind === 'fix' && c.pointId === e.id);
          if (fc) { fc.x = e.x; fc.y = e.y; }
        }
        this.commit();
      });
    });
    body.querySelectorAll('input[data-toggle]').forEach(inp => {
      inp.addEventListener('change', () => {
        const k = inp.dataset.toggle;
        if (k === 'construction-all') {
          for (const target of constructionTargets) target.construction = inp.checked;
          this.commit();
          this.refreshUI();
          return;
        }
        e[k] = inp.checked;
        if (k === 'fixed' && inp.checked && e instanceof Point) {
          sketch.constraints.push(new FixConstraint(e.id, e.x, e.y));
        }
        if (k === 'fixed' && !inp.checked && e instanceof Point) {
          sketch.constraints = sketch.constraints.filter(c => !(c.kind === 'fix' && c.pointId === e.id));
        }
        this.commit();
        this.refreshUI();
      });
    });
    body.querySelectorAll('.constraint-pill .x').forEach(x => {
      x.addEventListener('click', () => {
        const cid = x.dataset.cid;
        sketch.constraints = sketch.constraints.filter(c => c.id !== cid);
        // recompute fixed flags from remaining FixConstraints
        for (const en of sketch.entities) for (const c of en.children()) c.fixed = false;
        for (const c of sketch.constraints) if (c.kind === 'fix') {
          for (const en of sketch.entities) for (const p of en.children()) if (p.id === c.pointId) p.fixed = true;
        }
        this.commit();
        this.refreshUI();
      });
    });
  }
}

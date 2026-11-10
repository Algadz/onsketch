import { evaluate } from '../core/expr.js';
import { dist } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { CONSTRAINT_GLYPHS, constraintLabel, Constraint } from '../core/constraints.js';
import { isAngular, isDimension } from '../core/equations.js';
import { availableDimensions, availableRelations, constraintAppliesToSelection } from '../editor/relations.js';

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class PanelsMixin {

  /* ---- Sidebar ---- */
  _setupSidebar() {
    document.getElementById('project-name').addEventListener('input', (e) => {
      this.project.name = e.target.value;
      this.scheduleAutosave();
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
    this._refreshFab();
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

  /* ---- Properties window ----
     Order follows what people do with a selection: see what it is, change
     its values, then tie it to other shapes.
       header      what is selected (+ its layer)
       Properties  editable values (position, length, angle, radius…)
       Relations   toggle buttons: lit when the relation already holds,
                   click again to remove it; below, every relation on the
                   selection (hover = highlight on canvas, click = select)
       Dimensions  the selection's dimensions with editable values, then
                   buttons for the ones it does not have yet
     A selected relation or dimension shows what it ties, its value and a
     Delete button. Sections with nothing to offer are left out. */
  _refreshSelectionPanel() {
    const sel = this.selectedEntitiesAndPoints();
    const body = document.getElementById('sel-body');
    const ink = this.selectedStrokes();
    const count = sel.length + ink.length;
    document.getElementById('sel-count').textContent = count + (count === 1 ? ' item' : ' items');
    this._clearPanelHover();

    if (sel.length === 0 && ink.length) {
      body.innerHTML = this._inkSectionHTML(ink);
      this._bindInkSection(body);
      return;
    }
    if (sel.length === 0) {
      body.innerHTML = `<div class="ps-empty">
        <strong>Nothing selected</strong>
        <span>Click a shape to see its values, relations and dimensions. Ctrl-click adds to the selection; select two shapes to relate them.</span>
      </div>`;
      return;
    }

    const sketch = this.activeSketch();
    const geom = sel.filter(e => !(e instanceof Constraint));
    const cons = sel.filter(e => e instanceof Constraint);
    let html = '';
    if (!geom.length) {
      html = this._constraintSectionHTML(cons);
    } else {
      html += this._selHeaderHTML(geom, cons);
      html += this._geomPropsHTML(geom, sketch);
      html += this._relationsHTML(geom, sketch);
      html += this._dimensionsHTML(geom, sketch);
    }
    body.innerHTML = html + this._inkSectionHTML(ink);
    this._bindInkSection(body);
    this._bindSelectionPanel(body, geom, sketch);
  }

  _glyphOf(e) {
    if (e instanceof Constraint) return CONSTRAINT_GLYPHS[e.kind] || '•';
    return e instanceof Point ? 'P' : e instanceof Line ? 'L' : e instanceof Circle ? 'C' : e instanceof Arc ? 'A' : '?';
  }

  _kindName(e) {
    return e instanceof Point ? 'point' : e instanceof Line ? 'line' : e instanceof Circle ? 'circle' : e instanceof Arc ? 'arc' : 'item';
  }

  /** Shapes a constraint ties, as the user thinks of them: a line rather
   *  than its two end points, a circle rather than its centre. */
  _relationParticipants(c, byId) {
    const ids = this._relationRefIds(c, byId);
    for (const id of c.refs()) if (byId.has(id)) ids.add(id);   // circles / arcs themselves
    const out = [];
    const sketch = this.activeSketch();
    for (const e of sketch?.entities || []) {
      if (e instanceof Line && ids.has(e.p1.id) && ids.has(e.p2.id) && !['fix', 'arcEndpointFix', 'coincident'].includes(c.kind)) {
        out.push(e); ids.delete(e.p1.id); ids.delete(e.p2.id); ids.delete(e.id);
      } else if ((e instanceof Circle || e instanceof Arc) && ids.has(e.id)) {
        out.push(e); ids.delete(e.id); ids.delete(e.center.id);
      } else if (e instanceof Line && ids.has(e.id)) {
        out.push(e); ids.delete(e.id); ids.delete(e.p1.id); ids.delete(e.p2.id);
      }
    }
    for (const id of ids) { const x = byId.get(id); if (x) out.push(x); }
    return out;
  }

  _hoverAttr(items) {
    return `data-hover="${esc(items.map(x => x.id).join(' '))}"`;
  }

  _selHeaderHTML(geom, cons) {
    const all = [...geom, ...cons];
    const layerOf = (e) => { const owner = this.project.ownerOf(e); return owner ? this.project.layerOf(owner) : null; };
    if (all.length === 1) {
      const e = geom[0];
      const layer = layerOf(e);
      const state = e instanceof Point && e.fixed ? '<span class="ps-tag on">fixed</span>'
        : e.construction ? '<span class="ps-tag">construction</span>' : '';
      return `<div class="ps-head">
        <span class="ps-glyph">${this._glyphOf(e)}</span>
        <span class="ps-title"><strong>${esc(this._kindName(e)[0].toUpperCase() + this._kindName(e).slice(1))}</strong><span class="ps-id">${esc(e.id)}</span></span>
        ${state}${layer && this.project.layers.length > 1 ? `<span class="layer-tag">${esc(layer.name)}</span>` : ''}
      </div>`;
    }
    const counts = new Map();
    for (const e of all) {
      const k = e instanceof Constraint ? 'relation' : this._kindName(e);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const summary = [...counts].map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
    let rows = '';
    for (const e of all) {
      const label = e instanceof Constraint ? constraintLabel(e) : this._kindName(e);
      const layer = e instanceof Constraint ? null : layerOf(e);
      rows += `<button class="sel-item" data-only="${esc(e.id)}" ${this._hoverAttr([e])} title="Select only this">
        <span class="glyph">${this._glyphOf(e)}</span><span>${esc(label)} <span class="ps-id">${esc(e.id)}</span></span>
        ${layer && this.project.layers.length > 1 ? `<span class="layer-tag">${esc(layer.name)}</span>` : ''}</button>`;
    }
    return `<details class="ps-multi"${all.length <= 4 ? ' open' : ''}>
      <summary><span class="ps-glyph">${all.length}</span><strong>${esc(summary)}</strong></summary>
      <div class="stack-list">${rows}</div>
    </details>`;
  }

  _numRow(label, key, value, unit, title = '') {
    return `<div class="prop-row"><label>${label}</label><div class="unit-row">
      <input type="text" inputmode="decimal" data-edit="${key}" value="${Number(value.toFixed(4))}"${title ? ` title="${esc(title)}"` : ''} spellcheck="false">
      <span>${unit}</span></div></div>`;
  }

  _geomPropsHTML(geom, sketch) {
    const u = esc(this.project.units);
    const e = geom[0];
    let html = '';
    const curves = geom.filter(x => x instanceof Line || x instanceof Circle || x instanceof Arc);
    if (geom.length === 1) {
      if (e instanceof Point) {
        html += this._numRow('X', 'x', e.x, u) + this._numRow('Y', 'y', e.y, u);
      } else if (e instanceof Line) {
        const len = dist(e.p1, e.p2);
        const dim = this._lineLengthDim(e, sketch);
        html += this._numRow('Length', 'length', len, u, dim ? `Sets dimension ${dim.name || ''}`.trim() : 'Moves the second end along the line');
        html += this._numRow('Angle', 'angle', Math.atan2(e.p2.y - e.p1.y, e.p2.x - e.p1.x) * 180 / Math.PI, '°', 'Turns the line about its first end');
      } else if (e instanceof Circle) {
        html += this._numRow('Centre X', 'cx', e.center.x, u) + this._numRow('Centre Y', 'cy', e.center.y, u);
        html += this._numRow('Diameter', 'diameter', e.r * 2, u);
      } else if (e instanceof Arc) {
        html += this._numRow('Radius', 'r', e.r, u);
      }
    }
    if (curves.length) {
      const on = curves.filter(x => x.construction).length;
      html += `<div class="prop-row"><label>Construction</label><label class="switch" title="Construction geometry guides the sketch but is not part of the drawing">
        <input type="checkbox" data-toggle="construction"${on === curves.length ? ' checked' : ''}${on && on < curves.length ? ' data-mixed' : ''}><span></span></label></div>`;
    }
    const movable = geom.filter(x => sketch.entities.includes(x));
    if (movable.length && this.project.layers.length > 1) {
      html += `<div class="prop-row"><label>Layer</label><select data-move-layer>
        ${[...this.project.layers].reverse().map(l => `<option value="${l.id}"${l.id === this.project.activeLayerId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select></div>`;
    }
    return html ? `<div class="sb-subhead">Properties</div>${html}` : '';
  }

  _lineLengthDim(line, sketch) {
    const ends = new Set([line.p1.id, line.p2.id]);
    return sketch.constraints.find(k => k.kind === 'distance' && !k.axis && !k.driven && ends.has(k.p1) && ends.has(k.p2) && k.p1 !== k.p2) || null;
  }

  _relationsHTML(geom, sketch) {
    const byId = this._lookupMap([sketch]);
    const selIds = new Set(geom.map(x => x.id));
    const rels = availableRelations(geom);
    let html = '';
    if (rels.length) {
      html += '<div class="rel-grid">';
      for (const r of rels) {
        const { state, removable } = this.relationState(r.kind, geom);
        if (state === 'na') continue;
        const title = state === 'on'
          ? (removable ? `${r.label} is applied. Click to remove it.` : `${r.label} already holds through other relations.`)
          : state === 'partial' ? `${r.label} holds for part of the selection. Click to apply it to all.`
          : `Add ${r.label.toLowerCase()}`;
        html += `<button class="rel-btn ${state}" data-rel="${r.kind}" aria-pressed="${state === 'on'}" title="${esc(title)}">
          <span class="glyph">${r.glyph}</span><span class="rel-name">${r.label}</span>${state === 'on' ? '<span class="rel-check">✓</span>' : state === 'partial' ? '<span class="rel-check">–</span>' : ''}</button>`;
      }
      html += '</div>';
    }
    const related = (sketch?.constraints || []).filter(c => !isDimension(c) && c.kind !== 'paramFix' && constraintAppliesToSelection(c, geom));
    if (related.length) {
      html += '<div class="rel-list">';
      for (const c of related) {
        const parts = this._relationParticipants(c, byId);
        const others = parts.filter(x => !selIds.has(x.id) && !(x instanceof Point && geom.some(g => g.children && g.children().includes(x))));
        // Say what else it ties; with several shapes selected, say which.
        const name = (o) => `${this._kindName(o)} ${esc(o.id)}`;
        const what = others.length ? `<span class="rel-with">with ${others.map(name).join(', ')}</span>`
          : (geom.length > 1 || parts.some(x => !selIds.has(x.id))) && parts.length ? `<span class="rel-with">on ${parts.map(name).join(', ')}</span>` : '';
        html += `<div class="rel-row" data-cid="${c.id}" ${this._hoverAttr(parts)} title="Click to select this relation">
          <span class="glyph">${CONSTRAINT_GLYPHS[c.kind] || '•'}</span><span class="rel-text">${esc(constraintLabel(c))}${what}</span>
          <button class="rel-del" data-del="${c.id}" title="Remove this relation" aria-label="Remove ${esc(constraintLabel(c))}">×</button></div>`;
      }
      html += '</div>';
    }
    return html ? `<div class="sb-subhead">Relations</div>${html}` : '';
  }

  _dimRowHTML(c, removable = true) {
    const ang = isAngular(c);
    const label = c.kind === 'radius' && c.isDiameter ? 'Diameter' : constraintLabel(c);
    const glyph = c.kind === 'radius' && c.isDiameter ? '⌀' : (CONSTRAINT_GLYPHS[c.kind] || '↔');
    const value = c.driven
      ? `<span class="dim-val driven" title="Driven: measured from the shapes, not driving them">${esc(this.dimensionEditText(c))}</span>`
      : `<input type="text" class="dim-val${c.exprError ? ' bad' : ''}" data-dim-edit="${c.id}" value="${esc(this.dimensionEditText(c))}" spellcheck="false" title="${esc(c.exprError || 'Type a value or =equation')}">`;
    return `<div class="dim-row" data-cid="${c.id}" ${this._hoverAttr([c])}>
      <span class="glyph">${glyph}</span>
      <span class="dim-name" title="${esc(label)}">${esc(c.name || label)}</span>
      ${value}<span class="dim-unit">${ang ? '°' : esc(this.project.units)}</span>
      ${removable ? `<button class="rel-del" data-del="${c.id}" title="Delete this dimension" aria-label="Delete dimension">×</button>` : ''}
    </div>`;
  }

  _dimensionsHTML(geom, sketch) {
    const existing = (sketch?.constraints || []).filter(c => isDimension(c) && c.kind !== 'directedAngle' && constraintAppliesToSelection(c, geom));
    // Offer a dimension only if the selection does not already have it.
    const mine = new Set(geom.flatMap(g => [g.id, ...(g.children ? g.children().map(x => x.id) : [])]));
    const sizeKey = (k) => (k === 'diameter' ? 'radius' : k);
    const has = (kind) => existing.some(c => sizeKey(c.kind) === sizeKey(kind) && !c.axis &&
      [...this._relationRefIds(c)].every(id => mine.has(id)));
    const dims = availableDimensions(geom).filter(d => !has(d.kind));
    let html = existing.map(c => this._dimRowHTML(c)).join('');
    if (dims.length) {
      html += '<div class="dim-add">';
      for (const d of dims) html += `<button class="mini-btn" data-dim="${d.kind}" title="Place a ${d.label.toLowerCase()} dimension on the canvas"><span class="glyph">${d.glyph}</span>${d.label}</button>`;
      html += '</div>';
    }
    return html ? `<div class="sb-subhead">Dimensions</div>${html}` : '';
  }

  _constraintSectionHTML(cons) {
    const sketch = this.activeSketch();
    const byId = this._lookupMap([sketch]);
    if (cons.length > 1) {
      let html = `<div class="ps-head"><span class="ps-glyph">${cons.length}</span><span class="ps-title"><strong>${cons.length} relations and dimensions</strong></span></div><div class="rel-list">`;
      for (const c of cons) {
        html += `<div class="rel-row" data-cid="${c.id}" ${this._hoverAttr(this._relationParticipants(c, byId))}>
          <span class="glyph">${CONSTRAINT_GLYPHS[c.kind] || '•'}</span><span class="rel-text">${esc(constraintLabel(c))}</span></div>`;
      }
      return html + `</div><button class="rel-btn danger full ps-delete" data-delete-sel>Delete ${cons.length}</button>`;
    }
    const c = cons[0];
    const dim = isDimension(c);
    const parts = this._relationParticipants(c, byId);
    let html = `<div class="ps-head">
      <span class="ps-glyph">${CONSTRAINT_GLYPHS[c.kind] || '•'}</span>
      <span class="ps-title"><strong>${esc(constraintLabel(c))}</strong><span class="ps-id">${esc(c.name || c.id)}</span></span>
      <span class="ps-tag">${dim ? 'dimension' : 'relation'}</span>
    </div>`;
    if (parts.length) {
      html += '<div class="sb-subhead">Ties</div><div class="stack-list">';
      for (const x of parts) {
        html += `<button class="sel-item" data-only="${esc(x.id)}" ${this._hoverAttr([x])} title="Select this ${this._kindName(x)}">
          <span class="glyph">${this._glyphOf(x)}</span><span>${this._kindName(x)} <span class="ps-id">${esc(x.id)}</span></span></button>`;
      }
      html += '</div>';
    }
    if (dim) {
      html += '<div class="sb-subhead">Value</div>' + this._dimRowHTML(c, false);
      if (['distance', 'radius', 'pointLineDistance'].includes(c.kind)) {
        html += `<div class="prop-row"><label>Driven</label><label class="switch" title="A driven dimension only measures; it does not move the shapes">
          <input type="checkbox" data-driven${c.driven ? ' checked' : ''}><span></span></label></div>`;
      }
    }
    html += `<button class="rel-btn danger full ps-delete" data-delete-sel>Delete ${dim ? 'dimension' : 'relation'}</button>`;
    return html;
  }

  _clearPanelHover() {
    for (const x of this._panelHover || []) x.hover = false;
    this._panelHover = [];
  }

  _bindSelectionPanel(body, geom, sketch) {
    const byId = this._lookupMap([sketch]);
    const cById = new Map((sketch?.constraints || []).map(c => [c.id, c]));
    const find = (id) => byId.get(id) || cById.get(id);

    // Hover a row → light up what it is about on the canvas.
    body.querySelectorAll('[data-hover]').forEach(el => {
      el.addEventListener('pointerenter', () => {
        this._clearPanelHover();
        const items = el.dataset.hover.split(' ').map(find).filter(Boolean);
        const c = el.dataset.cid && cById.get(el.dataset.cid);
        if (c) items.push(c);
        for (const x of items) if (!x.hover) { x.hover = true; this._panelHover.push(x); }
        this.requestRender();
      });
      el.addEventListener('pointerleave', () => { this._clearPanelHover(); this.requestRender(); });
    });
    const selectOnly = (x) => {
      if (!x) return;
      this._clearPanelHover();
      this.clearSelection();
      this.setSelected(x, true);
      this.refreshUI();
      this.requestRender();
    };
    body.querySelectorAll('[data-only]').forEach(b => b.addEventListener('click', () => selectOnly(find(b.dataset.only))));
    body.querySelectorAll('.rel-row[data-cid], .dim-row[data-cid]').forEach(row => row.addEventListener('click', (ev) => {
      if (ev.target.closest('button, input')) return;
      selectOnly(cById.get(row.dataset.cid));
    }));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = b.dataset.del;
      const gone = sketch.constraints.filter(c => c.id === id);
      sketch.constraints = sketch.constraints.filter(c => c.id !== id);
      this._syncFixFlags([], gone);
      this.commit();
      this.refreshUI();
    }));
    body.querySelectorAll('[data-delete-sel]').forEach(b => b.addEventListener('click', () => this.deleteSelection()));

    const mover = body.querySelector('select[data-move-layer]');
    if (mover) mover.addEventListener('change', () => this.moveSelectionToLayer(mover.value));
    body.querySelectorAll('[data-rel]').forEach(b => b.addEventListener('click', () => this.toggleRelation(b.dataset.rel)));
    body.querySelectorAll('[data-dim]').forEach(b => b.addEventListener('click', () => this.applyDimension(b.dataset.dim)));

    // Dimension values: Enter or leaving the field applies; a bad value
    // stays red with the reason as tooltip.
    body.querySelectorAll('input[data-dim-edit]').forEach(inp => {
      const c = cById.get(inp.dataset.dimEdit);
      const apply = () => {
        if (!c || inp.value === this.dimensionEditText(c)) return;
        const err = this.setDimensionFromText(c, inp.value);
        if (err) { inp.classList.add('bad'); inp.title = err; return; }
        this.refreshUI();
      };
      inp.addEventListener('change', apply);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
        if (ev.key === 'Escape') { inp.value = this.dimensionEditText(c); inp.blur(); }
        ev.stopPropagation();
      });
      inp.addEventListener('input', () => { inp.classList.remove('bad'); });
    });
    const driven = body.querySelector('input[data-driven]');
    if (driven) driven.addEventListener('change', () => {
      const c = this.selectedEntitiesAndPoints().find(x => x instanceof Constraint);
      if (!c) return;
      c.driven = driven.checked;
      if (c.driven) { c.expr = null; this.refreshDrivenDimensions(); }
      this.commit();
      this.refreshUI();
    });

    const e = geom[0];
    body.querySelectorAll('input[data-edit]').forEach(inp => {
      const apply = () => {
        let v = NaN;
        try { v = evaluate(inp.value, (n) => this._namedValue(n)); } catch { /* bad text */ }
        if (!Number.isFinite(v)) { inp.classList.add('bad'); return; }
        if (Math.abs(v) < 1e-12) v = 0;
        this._setGeomValue(e, inp.dataset.edit, v, sketch);
      };
      inp.addEventListener('change', apply);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
        ev.stopPropagation();
      });
      inp.addEventListener('input', () => inp.classList.remove('bad'));
    });
    const constr = body.querySelector('input[data-toggle="construction"]');
    if (constr) {
      constr.indeterminate = constr.hasAttribute('data-mixed');
      constr.addEventListener('change', () => {
        for (const x of geom) if (x instanceof Line || x instanceof Circle || x instanceof Arc) x.construction = constr.checked;
        this.commit();
        this.refreshUI();
      });
    }
  }

  /** Typed value from Properties. Where a driving dimension already sets
   *  the value, the dimension is changed instead so the edit sticks. */
  _setGeomValue(e, key, v, sketch) {
    if (e instanceof Point && (key === 'x' || key === 'y')) {
      e[key] = v;
      // A Fix holds the point at its own (x, y): move that target too.
      const fc = sketch.constraints.find(c => c.kind === 'fix' && c.pointId === e.id);
      if (fc) fc[key] = v;
    } else if (e instanceof Line && (key === 'length' || key === 'angle')) {
      const len = dist(e.p1, e.p2);
      if (key === 'length') {
        if (!(v > 0)) return;
        const dim = this._lineLengthDim(e, sketch);
        if (dim) { this.setDimensionFromText(dim, String(v)); this.refreshUI(); return; }
        const k = len > 1e-12 ? v / len : 1;
        e.p2.x = e.p1.x + (e.p2.x - e.p1.x) * k;
        e.p2.y = e.p1.y + (e.p2.y - e.p1.y) * k;
      } else {
        const a = v * Math.PI / 180;
        e.p2.x = e.p1.x + len * Math.cos(a);
        e.p2.y = e.p1.y + len * Math.sin(a);
      }
    } else if ((e instanceof Circle || e instanceof Arc) && (key === 'r' || key === 'diameter')) {
      const r = key === 'diameter' ? v / 2 : v;
      if (!(r > 0)) return;
      const dim = sketch.constraints.find(c => c.kind === 'radius' && c.circleId === e.id && !c.driven);
      if (dim) { this.setDimensionFromText(dim, String(dim.isDiameter ? r * 2 : r)); this.refreshUI(); return; }
      e.r = r;
      if (e instanceof Arc) e.syncEnds();
    } else if (e instanceof Circle && (key === 'cx' || key === 'cy')) {
      e.center[key === 'cx' ? 'x' : 'y'] = v;
      const fc = sketch.constraints.find(c => c.kind === 'fix' && c.pointId === e.center.id);
      if (fc) fc[key === 'cx' ? 'x' : 'y'] = v;
    } else return;
    this.commit();
    this.refreshUI();
  }
}

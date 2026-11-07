import { evaluate, isEquation } from '../core/expr.js';
import {
  allDimensions, ensureDimensionNames, internalValue, isAngular, renameReferences,
  solveEquations, userValue, validateName,
} from '../core/equations.js';
import { CONSTRAINT_LABELS } from '../core/constraints.js';

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, angular) => (v == null || !Number.isFinite(v)) ? '—' : (angular ? v.toFixed(2) + '°' : Number(v.toFixed(4)).toString());

/* =============== EQUATIONS UI ==================================
   Typed dimension values accept units (4in, 25mm, 30deg) and
   equations (=D1*2, width/2 + 5mm). The Equations window lists global
   variables and every dimension with its name, equation and value,
   like SolidWorks' Equations manager.
   ============================================================ */
export class EquationsMixin {
  /** Evaluate variables + dimension equations into dimension values.
   *  Called before every commit / solve. */
  _applyEquations() {
    ensureDimensionNames(this.project);
    let changed = 0;
    const errors = solveEquations(this.project, (c, v) => {
      if (c.kind === 'offsetDistance') this._setOffsetDistanceValue(c, v);
      else c.value = internalValue(c, v);
      changed++;
    });
    if (errors) document.getElementById('status-hint').textContent = `${errors} equation error${errors > 1 ? 's' : ''}: see the Equations window.`;
    return { errors, changed };
  }

  /** Equations are global: when they change dimension values, solve once
   *  with every layer editable so the change reaches geometry on all
   *  layers, not just the active one. Groups that can't be solved stay as
   *  they were. */
  _solveAllLayers() {
    const sketch = this.activeSketch();
    if (!sketch) return;
    this.project.editAllLayers = true;
    try {
      this.solver.solve(sketch, this.project.sketches, [], { diagnostics: false, revertOnFailure: true });
      for (const e of sketch.entities) if (e.syncEnds) e.syncEnds();
    } finally {
      this.project.editAllLayers = false;
      this.project.syncLocks();
    }
  }

  /**
   * Read typed text for a dimension: a value with units, an arithmetic
   * expression, or an equation (kept). Throws with a readable message.
   * @param {object|null} c  the dimension (null while creating one)
   * @param {boolean} angular
   * @returns {{ value:number, expr:string|null }}  value in user units
   */
  parseDimensionInput(text, c, angular) {
    const src = String(text).trim();
    const lookup = (name) => {
      if (c && name === c.name) throw new Error(`${name} can't refer to itself`);
      const v = (this.project.variables || []).find(x => x.name === name);
      if (v) return v.value ?? evaluate(v.expr, lookup);
      const d = allDimensions(this.project).find(x => x.name === name);
      return d ? userValue(d) : undefined;
    };
    const value = evaluate(src, lookup);
    if (!angular && !(value > 0)) throw new Error('Must be greater than 0');
    return { value, expr: isEquation(src) ? src.replace(/^=\s*/, '') : null };
  }

  /** Value of a variable or dimension name, for plain numeric inputs. */
  _namedValue(name) {
    const v = (this.project.variables || []).find(x => x.name === name);
    if (v) return v.value;
    const d = allDimensions(this.project).find(x => x.name === name);
    return d ? userValue(d) : undefined;
  }

  /** Text shown when a dimension is edited: its equation if it has one
   *  (as SolidWorks does), otherwise its value. */
  dimensionEditText(c) {
    if (c.expr) return '=' + c.expr;
    const v = userValue(c);
    return v == null ? '' : Number(v.toFixed(6)).toString();
  }

  /**
   * Floating input used to type a dimension value. Stays open with a red
   * border and the error as tooltip / status text until the text is
   * valid or the user presses Escape.
   * @param {{x,y}} pos  screen position in the workspace
   * @param {(text:string) => string|null} submit  returns an error or null
   */
  openValueInput(pos, text, submit, cancel = () => {}) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dim-input';
    input.spellcheck = false;
    input.value = text;
    input.style.left = pos.x + 'px';
    input.style.top = pos.y + 'px';
    const fit = () => { input.style.width = Math.max(80, Math.min(260, input.value.length * 7.4 + 22)) + 'px'; };
    fit();
    document.getElementById('workspace').appendChild(input);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    let done = false;
    const close = () => { done = true; input.remove(); };
    const tryCommit = () => {
      const err = submit(input.value);
      if (!err) { close(); return true; }
      input.classList.add('bad');
      input.title = err;
      document.getElementById('status-hint').textContent = err;
      return false;
    };
    input.addEventListener('input', () => { input.classList.remove('bad'); fit(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); tryCommit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); cancel(); }
    });
    input.addEventListener('blur', () => {
      if (done) return;
      if (!tryCommit()) { close(); cancel(); }      // leaving with bad text cancels
    });
    return { el: input, dispose: () => { if (!done) close(); } };
  }

  /** Apply typed text to an existing dimension; returns an error or null. */
  setDimensionFromText(c, text) {
    try {
      const { value, expr } = this.parseDimensionInput(text, c, isAngular(c));
      c.expr = expr;
      if (c.kind === 'offsetDistance') this._setOffsetDistanceValue(c, value);
      else c.value = internalValue(c, value);
      c.exprError = null;
      this.commit();
      this._refreshEquationsPanel();
      return null;
    } catch (e) {
      return e.message;
    }
  }

  /* ---- Equations window ---- */
  _setupEquationsPanel() {
    const body = document.getElementById('equations-body');
    if (!body) return;
    body.addEventListener('change', (e) => this._onEquationsEdit(e));
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-eq]');
      if (!b) return;
      if (b.dataset.eq === 'add-var') {
        let n = 1;
        while (validateName(this.project, 'var' + n)) n++;
        this.project.variables.push({ name: 'var' + n, expr: '10' });
      } else if (b.dataset.eq === 'del-var') {
        this.project.variables.splice(+b.dataset.i, 1);
      } else if (b.dataset.eq === 'names') {
        this.showDimNames = !this.showDimNames;
        this._savePrefs();
        this.requestRender();
        this._refreshEquationsPanel();
        return;
      }
      this.commit();
      this._refreshEquationsPanel();
    });
  }

  _onEquationsEdit(e) {
    const inp = e.target;
    const kind = inp.dataset.k;
    if (!kind) return;
    const dims = allDimensions(this.project);
    const showErr = (msg) => { inp.classList.add('bad'); inp.title = msg; document.getElementById('status-hint').textContent = msg; };
    if (kind === 'var-name' || kind === 'dim-name') {
      const obj = kind === 'var-name' ? this.project.variables[+inp.dataset.i] : dims[+inp.dataset.i];
      const name = inp.value.trim();
      if (name === obj.name) return;
      const err = validateName(this.project, name, obj);
      if (err) { showErr(err); return; }
      renameReferences(this.project, obj.name, name);
      obj.name = name;
    } else if (kind === 'var-expr') {
      const v = this.project.variables[+inp.dataset.i];
      v.expr = inp.value.trim().replace(/^=\s*/, '') || '0';
    } else if (kind === 'dim-expr') {
      const c = dims[+inp.dataset.i];
      const text = inp.value.trim();
      if (!text) { c.expr = null; }
      else {
        const err = this.setDimensionFromText(c, text);
        if (err) { showErr(err); return; }
      }
    }
    this.commit();
    this._refreshEquationsPanel();
  }

  _refreshEquationsPanel() {
    const body = document.getElementById('equations-body');
    if (!body) return;
    const project = this.project;
    const vars = project.variables;
    const dims = allDimensions(project);
    // Keep the focused field if the user is typing in this window.
    if (body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    let html = `<div class="eq-head"><span>Global variables</span><button class="link-btn" data-eq="add-var">+ Add</button></div>`;
    if (!vars.length) html += '<div class="hint">None yet. Variables can be used in any dimension, e.g. <code>=width/2</code>.</div>';
    html += '<div class="eq-grid">';
    vars.forEach((v, i) => {
      html += `<input class="eq-name" data-k="var-name" data-i="${i}" value="${esc(v.name)}" aria-label="Variable name">
        <input class="eq-expr${v.error ? ' bad' : ''}" data-k="var-expr" data-i="${i}" value="${esc(v.expr)}" title="${esc(v.error || '')}" aria-label="Variable expression">
        <span class="eq-val">${v.error ? '!' : fmt(v.value, false)}</span>
        <button class="fwin-x" data-eq="del-var" data-i="${i}" title="Delete variable">&times;</button>`;
    });
    html += '</div>';
    html += `<div class="eq-head"><span>Dimensions</span><button class="link-btn" data-eq="names">${this.showDimNames ? 'Hide' : 'Show'} names on canvas</button></div>`;
    if (!dims.length) html += '<div class="hint">Dimensions you add appear here as D1, D2, …</div>';
    html += '<div class="eq-grid">';
    dims.forEach((c, i) => {
      const ang = isAngular(c);
      const kind = c.isDiameter ? 'Diameter' : (CONSTRAINT_LABELS[c.kind] || c.kind);
      html += `<input class="eq-name" data-k="dim-name" data-i="${i}" value="${esc(c.name || '')}" title="${esc(kind)}" aria-label="Dimension name">
        <input class="eq-expr${c.exprError ? ' bad' : ''}" data-k="dim-expr" data-i="${i}" value="${esc(c.expr ? '=' + c.expr : '')}"
          placeholder="${c.driven ? 'driven (reference)' : 'value or =equation'}" ${c.driven ? 'disabled' : ''} title="${esc(c.exprError || kind)}" aria-label="Dimension equation">
        <span class="eq-val">${c.exprError ? '!' : fmt(userValue(c), ang)}</span><span></span>`;
    });
    html += '</div><div class="hint">Units: mm cm m in " ft, deg rad. Functions: sin cos tan sqrt abs min max, pi. Start with = to keep an equation.</div>';
    body.innerHTML = html;
  }

  /** Label text for a dimension on the canvas: Σ marks an equation;
   *  names show when "Show names" is on. */
  dimensionLabel(c, text) {
    if (!c) return text;
    let t = c.expr ? 'Σ ' + text : text;
    if (this.showDimNames && c.name) t = `${c.name}: ${t}`;
    return t;
  }
}

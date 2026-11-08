import { evaluate, isEquation } from '../core/expr.js';
import {
  allDimensions, ensureDimensionNames, internalValue, isAngular, renameReferences,
  solveEquations, userValue, validateName,
} from '../core/equations.js';
import { CONSTRAINT_LABELS } from '../core/constraints.js';

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLAIN = /^\s*-?\d+(?:\.\d+)?\s*$/;          // a plain number (scrubbable)
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
    if (this.refreshDrivenDimensions) this.refreshDrivenDimensions();   // floating dimensions measure the geometry
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
   * @param {{selfName?:string}} opts  name of the dimension being edited
   *
   * While it is open, clicking a line, circle or arc on the canvas inserts
   * that shape's dimension name (creating a floating one if needed), see
   * dim-links.js.
   */
  openValueInput(pos, text, submit, cancel = () => {}, opts = {}) {
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
    let done = false, hold = false;
    const close = () => { done = true; input.remove(); if (this._valueInput === vi) this._valueInput = null; };
    const refocus = () => setTimeout(() => { if (!done) input.focus(); }, 0);
    const vi = {
      selfName: opts.selfName || null,
      /** Keep the box open through the canvas click that follows. */
      hold: () => { hold = true; refocus(); },
      /** Insert a name: at the caret in an equation, else as =name. */
      insert: (name) => {
        hold = true;
        const v = input.value;
        if (/^\s*=/.test(v)) {
          const a = input.selectionStart ?? v.length, b = input.selectionEnd ?? v.length;
          const before = v.slice(0, a), after = v.slice(b);
          const pad = /[\w.)]$/.test(before) ? ' + ' : '';
          input.value = before + pad + name + after;
          const caret = (before + pad + name).length;
          setTimeout(() => { if (!done) { input.focus(); input.setSelectionRange(caret, caret); } }, 0);
        } else {
          input.value = '=' + name;
          setTimeout(() => { if (!done) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }, 0);
        }
        input.classList.remove('bad');
        fit();
      },
    };
    this._valueInput = vi;
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
      if (hold) { hold = false; return; }           // a canvas pick: stay open
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
    body.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('[data-scrub]');
      if (el && e.button === 0) this._beginScrub(el, e);
    });
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

  /* ---- Blender-style scrubbing on value boxes ----
     Press on a value and drag sideways: the value changes by a step that
     fits its size (1400 → 10 per pixel, 40 → 0.1), Shift for 10× finer,
     Ctrl to snap to round numbers. Geometry follows live; release makes
     one undo step; Esc puts the start value back. A click without
     dragging edits the value as text. Only plain values scrub: equations
     and floating dimensions show why in their tooltip. */
  _beginScrub(el, ev) {
    const [kind, idxText] = el.dataset.scrub.split(':');
    const idx = +idxText;
    const dims = allDimensions(this.project);
    const target = kind === 'var' ? this.project.variables[idx] : dims[idx];
    if (!target) return;
    const angular = kind === 'dim' && isAngular(target);
    const v0 = kind === 'var' ? Number(target.expr) : userValue(target);
    if (!Number.isFinite(v0)) return;
    ev.preventDefault();
    const step0 = angular ? 0.5 : Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(v0), 1)))) / 100;
    const startX = ev.clientX;
    let moved = false, last = v0;
    el.setPointerCapture(ev.pointerId);
    const apply = (v) => {
      if (kind === 'var') target.expr = String(v);
      else if (target.kind === 'offsetDistance') this._setOffsetDistanceValue(target, v);
      else target.value = internalValue(target, v);
      this._applyEquations();
      this._solveAllLayers();
      this._updateEquationValues();
      this.requestRender();
    };
    const move = (e) => {
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; el.classList.add('scrubbing'); document.body.classList.add('scrubbing'); }
      const step = step0 * (e.shiftKey ? 0.1 : 1);
      let v = v0 + dx * step;
      const q = e.ctrlKey || e.metaKey ? step * 10 : step;
      v = Math.round(v / q) * q;
      v = Number(v.toFixed(Math.max(0, -Math.floor(Math.log10(q))) + 0));
      if (!angular && kind === 'dim' && !(v > 0)) v = q;
      if (v !== last) { last = v; apply(v); }
    };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); apply(v0); last = v0; end(false); } };
    const end = (keep = true) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key, true);
      el.classList.remove('scrubbing');
      document.body.classList.remove('scrubbing');
      if (moved && keep && last !== v0) this.commit();
      else if (moved) this.solveAndRender();
      this._refreshEquationsPanel();
    };
    const up = () => {
      if (!moved) {                                   // a click: edit as text
        end();
        const sel = kind === 'var' ? `[data-k="var-expr"][data-i="${idx}"]` : `[data-k="dim-expr"][data-i="${idx}"]`;
        const inp = document.querySelector('#equations-body ' + sel);
        if (inp) { if (kind === 'dim' && !inp.value) inp.value = String(Number(v0.toFixed(4))); inp.focus(); inp.select(); }
        return;
      }
      end();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key, true);
  }

  /** Update the value boxes in place (rebuilding would drop a scrub). */
  _updateEquationValues() {
    const body = document.getElementById('equations-body'); if (!body) return;
    const dims = allDimensions(this.project);
    body.querySelectorAll('[data-val]').forEach(span => {
      const [kind, i] = span.dataset.val.split(':');
      if (kind === 'var') { const v = this.project.variables[+i]; if (v) span.textContent = v.error ? '!' : fmt(v.value, false); }
      else { const c = dims[+i]; if (c) span.textContent = c.exprError ? '!' : fmt(userValue(c), isAngular(c)); }
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
        <span class="eq-val${PLAIN.test(v.expr || '') ? ' scrub' : ''}" data-val="var:${i}" ${PLAIN.test(v.expr || '') ? `data-scrub="var:${i}" title="Drag left / right to change (Shift: fine, Ctrl: round)"` : 'title="Set by an expression"'}>${v.error ? '!' : fmt(v.value, false)}</span>
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
        <span class="eq-val${!c.expr && !c.driven ? ' scrub' : ''}" data-val="dim:${i}" ${!c.expr && !c.driven ? `data-scrub="dim:${i}" title="Drag left / right to change (Shift: fine, Ctrl: round)"` : `title="${c.driven ? 'Floating: measures the geometry' : 'Set by its equation'}"`}>${c.exprError ? '!' : fmt(userValue(c), ang)}</span><span></span>`;
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

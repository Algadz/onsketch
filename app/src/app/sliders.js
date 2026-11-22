/* =============== VARIABLE SLIDERS ON THE SKETCH =================
   A global variable can show a slider on the drawing: the Equations
   window's ⊸ button on its row adds (or removes) it. It sits at a spot
   of the drawing (it pans and zooms with it) at a constant screen size:

       [ h ]──────●────────[ 50 mm ]

   - drag the knob, or press on the track, to set the value: the sketch
     (and its traced paths) follow live; release = one undo step;
     the value snaps to the slider's step, Shift for a tenth of it;
   - click the value to type one (units and the range aren't enforced
     when typed: the range only bounds the slider);
   - drag the name to move the slider; click it to select it: Properties
     then shows its range (min, max, step) and Remove slider; Delete
     removes it (the variable stays).
   A variable set by a formula (=width/2) shows its value, greyed: there
   is nothing to slide. Saved with the variable:

       variable { name, expr, slider?: { x, y, min, max, step } }

   Exports draw it as a static bar with "name = value unit".
   ============================================================ */

const W = 236, H = 30, NAME_W = 46, VALUE_W = 74, PAD = 12;
const PLAIN = /^\s*-?\d+(?:\.\d+)?(?:e-?\d+)?\s*$/i;

/** A round step near `range / 100`: 1, 2 or 5 × 10ⁿ. */
function niceStep(range) {
  const raw = Math.max(Math.abs(range) / 100, 1e-9);
  const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return Number(((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p).toPrecision(3));
}
/** A round number at or above `v` (1, 2, 5 × 10ⁿ). */
function niceCeil(v) {
  if (!(v > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
/** Default range for a value: 0 .. 2×, rounded (symmetric for negatives). */
export function defaultRange(v) {
  if (!Number.isFinite(v) || v === 0) return { min: 0, max: 10, step: 0.1 };
  const top = niceCeil(Math.abs(v) * 2);
  const min = v > 0 ? 0 : -top, max = v > 0 ? top : top;
  return { min, max, step: niceStep(max - min) };
}
const fmt = (v, step) => {
  const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step || 1))));
  return Number(v.toFixed(d)).toString();
};

export class SlidersMixin {
  /** Variables showing a slider. */
  _sliderVars() { return (this.project.variables || []).filter(v => v.slider); }

  /** Adds a slider for `v` in the middle of the view (selected), or removes it. */
  toggleVariableSlider(v) {
    if (!v) return;
    if (v.slider) { delete v.slider; if (this._sliderSel === v.name) this._sliderSel = null; }
    else {
      const view = this.view, spot = this._freeSliderSpot(), c = view.screenToWorld(spot);
      const val = Number.isFinite(v.value) ? v.value : Number(v.expr);
      v.slider = { x: c.x, y: c.y, ...defaultRange(val) };
      if (Number.isFinite(val)) { v.slider.min = Math.min(v.slider.min, val); v.slider.max = Math.max(v.slider.max, val); }
      this.clearSelection();
      this._sliderSel = v.name;
    }
    this.commit();
    this.refreshUI();
    this.requestRender();
  }

  /** Where a new slider goes: the first spot of the view (top middle
   *  first) that no open window and no other slider covers. */
  _freeSliderSpot() {
    const view = this.view, cr = this.canvas.getBoundingClientRect();
    const blocks = [...document.querySelectorAll('.fwin')].filter(w => !w.hidden && w.offsetParent)
      .map(w => { const r = w.getBoundingClientRect(); return { x0: r.left - cr.left - 8, y0: r.top - cr.top - 8, x1: r.right - cr.left + 8, y1: r.bottom - cr.top + 8 }; });
    for (const v of this._sliderVars()) { const b = this._sliderBox(v); blocks.push({ x0: b.x - 8, y0: b.y - 8, x1: b.x + b.w + 8, y1: b.y + b.h + 8 }); }
    const free = (x, y) => x >= 8 && y >= 8 && x + W <= view.cssW - 8 && y + H <= view.cssH - 8
      && !blocks.some(k => x < k.x1 && x + W > k.x0 && y < k.y1 && y + H > k.y0);
    for (const fy of [0.12, 0.24, 0.36, 0.5, 0.64, 0.78, 0.9]) {
      for (const fx of [0.5, 0.32, 0.68, 0.16, 0.84]) {
        const x = view.cssW * fx - W / 2, y = view.cssH * fy - H / 2;
        if (free(x, y)) return { x, y };
      }
    }
    return { x: view.cssW / 2 - W / 2, y: view.cssH * 0.12 };
  }

  removeSlider(name) {
    const v = (this.project.variables || []).find(x => x.name === name && x.slider);
    if (!v) return false;
    delete v.slider;
    this._sliderSel = null;
    this.commit(); this.refreshUI(); this.requestRender();
    return true;
  }

  /** Layout of a slider on screen. */
  _sliderBox(v) { return sliderBox(this.view, v); }

  /** Draws every slider on the canvas (exports: drawSliderBars). */
  _drawSliders() {
    this._sliderRects = drawSliderBars(this.renderer, this.view, this.project, { selected: this._sliderSel });
  }

  /** What part of a slider is under a screen point. */
  _sliderHit(sx, sy) {
    const pad = (this._inputScale || 1) > 1 ? 10 : 2;
    for (let i = (this._sliderRects || []).length - 1; i >= 0; i--) {
      const { v, b, free } = this._sliderRects[i];
      if (sx < b.x - pad || sx > b.x + b.w + pad || sy < b.y - pad || sy > b.y + b.h + pad) continue;
      const part = sx < b.x + NAME_W ? 'name' : sx > b.x + b.w - VALUE_W ? 'value' : 'track';
      return { v, b, free, part };
    }
    return null;
  }

  /** Value at a screen x on a slider's track, on its step. */
  _sliderValueAt(v, b, sx, fine) {
    const sl = v.slider, t = Math.max(0, Math.min(1, (sx - b.track.x0) / ((b.track.x1 - b.track.x0) || 1)));
    const step = (sl.step > 0 ? sl.step : niceStep(sl.max - sl.min)) * (fine ? 0.1 : 1);
    const raw = sl.min + t * (sl.max - sl.min);
    return Number((Math.round(raw / step) * step).toFixed(10));
  }

  /** Sets a slider's variable while dragging (live) or on release. */
  _setSliderValue(v, val, final) {
    v.expr = fmt(val, (v.slider.step || 1) / 10);
    this._applyEquations();
    this._solveAllLayers();
    if (final) { this.commit(); this._refreshEquationsPanel?.(); }
    else { this._autoUpdatePaths?.({ live: true }); this._updateEquationValues?.(); }
    this.requestRender();
  }

  /** Pointer down on the canvas: a slider takes it. @returns {boolean} */
  _sliderPointerDown(ev, screen) {
    if (ev.button !== 0 || this._valueInput) return false;
    const hit = this._sliderHit(screen.x, screen.y);
    if (!hit) return false;
    ev.preventDefault?.();
    const { v } = hit;
    const r = this.canvas.getBoundingClientRect();
    const local = (e) => ({ x: e.clientX - r.left, y: e.clientY - r.top });
    const start = local(ev);
    let moved = false;
    const v0 = v.expr;
    const finish = (e, cancel) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancelEv, true);
      window.removeEventListener('keydown', key, true);
      document.body.classList.remove('scrubbing');
      if (hit.part === 'track' && hit.free) {
        if (cancel) { v.expr = v0; this._applyEquations(); this._solveAllLayers(); this._autoUpdatePaths?.(); this.requestRender(); this._refreshEquationsPanel?.(); }
        else if (v.expr !== v0) this._setSliderValue(v, Number(v.expr), true);
      } else if (hit.part === 'name') {
        if (moved && !cancel) this.commit();
        else if (!moved) { this.clearSelection(); this._sliderSel = v.name; this.refreshUI(); this.requestRender(); }
      } else if (hit.part === 'value' && !moved && !cancel) this._typeSliderValue(v);
    };
    const move = (e) => {
      const p = local(e);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3 && hit.part !== 'track') return;
      moved = true;
      if (hit.part === 'track' && hit.free) {
        const b = this._sliderBox(v);
        this._setSliderValue(v, this._sliderValueAt(v, b, p.x, e.shiftKey), false);
      } else if (hit.part === 'name') {
        const w0 = this.view.screenToWorld(start), w1 = this.view.screenToWorld(p);
        v.slider.x = hit.sx0 + (w1.x - w0.x); v.slider.y = hit.sy0 + (w1.y - w0.y);
        this.requestRender();
      }
    };
    hit.sx0 = v.slider.x; hit.sy0 = v.slider.y;
    const up = (e) => finish(e, false);
    const cancelEv = (e) => finish(e, true);
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(e, true); } };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancelEv, true);
    window.addEventListener('keydown', key, true);
    if (hit.part === 'track' && hit.free) {
      document.body.classList.add('scrubbing');
      moved = true;
      this._setSliderValue(v, this._sliderValueAt(v, hit.b, start.x, ev.shiftKey), false);   // press on the track: jump there
    }
    return true;
  }

  /** Click on a slider's value: type one (or an =formula). */
  _typeSliderValue(v) {
    const b = this._sliderBox(v);
    this.openValueInput({ x: b.value.x + b.value.w / 2, y: b.y + b.h / 2 }, v.expr, (text) => {
      const t = String(text).trim().replace(/^=\s*/, '');
      if (!t) return 'Type a value';
      v.expr = t;                                // a formula is checked by the Equations solver
      this._applyEquations(); this._solveAllLayers();
      this.commit(); this.refreshUI(); this._refreshEquationsPanel?.(); this.requestRender();
      return null;
    }, () => {}, { selfName: v.name });
  }

  /** Properties for the selected slider (HTML), or '' when none. */
  _sliderSectionHTML() {
    const v = (this.project.variables || []).find(x => x.name === this._sliderSel && x.slider);
    if (!v) { this._sliderSel = null; return ''; }
    const sl = v.slider, esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const val = Number.isFinite(v.value) ? v.value : Number(v.expr);
    return `<div class="ps-head"><span class="ps-glyph">⊸</span><span class="ps-title"><strong>Slider</strong><span class="ps-id">${esc(v.name)} = ${esc(Number.isFinite(val) ? fmt(val, sl.step / 10) : v.expr)} ${esc(this.project.units)}</span></span></div>
      <div class="prop-row"><label>min</label><input type="number" step="any" data-slider="min" value="${sl.min}"></div>
      <div class="prop-row"><label>max</label><input type="number" step="any" data-slider="max" value="${sl.max}"></div>
      <div class="prop-row"><label>step</label><input type="number" step="any" min="0" data-slider="step" value="${sl.step}"></div>
      ${PLAIN.test(v.expr || '') ? '' : '<div class="hint">This variable is set by a formula: the slider only shows its value. Give it a plain number in the Equations window to slide it.</div>'}
      <div class="hint">Drag the knob (Shift: finer), click the value to type one, drag the name to move the slider. It shows in exports as a label.</div>
      <button class="rel-btn danger full" data-slider-remove>Remove slider</button>`;
  }
  _bindSliderSection(body) {
    const v = (this.project.variables || []).find(x => x.name === this._sliderSel && x.slider);
    if (!v) return;
    body.querySelectorAll('input[data-slider]').forEach(inp => inp.addEventListener('change', () => {
      const k = inp.dataset.slider, n = Number(inp.value);
      if (!Number.isFinite(n) || (k === 'step' && !(n > 0))) { inp.classList.add('bad'); return; }
      v.slider[k] = n;
      if (v.slider.min > v.slider.max) [v.slider.min, v.slider.max] = [v.slider.max, v.slider.min];
      this.commit(); this.refreshUI(); this.requestRender();
    }));
    body.querySelector('[data-slider-remove]')?.addEventListener('click', () => this.removeSlider(v.name));
  }
}

/** Layout of a slider at its spot, for a view. */
function sliderBox(view, v) {
  const s = view.worldToScreen({ x: v.slider.x, y: v.slider.y });
  const x = s.x, y = s.y;
  return { x, y, w: W, h: H, name: { x, y, w: NAME_W, h: H }, track: { x0: x + NAME_W + PAD, x1: x + W - VALUE_W - PAD, y: y + H / 2 },
    value: { x: x + W - VALUE_W, y, w: VALUE_W, h: H } };
}

/**
 * Draws the project's variable sliders with renderer `r` (the editor's,
 * or an export's: then a static bar labelled "name = value unit").
 * @returns {{v, b, free}[]} where each was drawn (screen px)
 */
export function drawSliderBars(r, view, project, { selected = null } = {}) {
  const vars = (project.variables || []).filter(v => v.slider);
  const rects = [];
  if (!vars.length) return rects;
  const ctx = r.ctx, th = r.theme, exp = !!r.exportMode;
  const unit = project.units;
  for (const v of vars) {
    const b = sliderBox(view, v), sl = v.slider;
    const val = Number.isFinite(v.value) ? v.value : Number(v.expr);
    const free = PLAIN.test(v.expr || '');
    const t = Math.max(0, Math.min(1, (val - sl.min) / ((sl.max - sl.min) || 1)));
    const sel = !exp && selected === v.name;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.beginPath(); roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = exp ? '#ffffff' : (th.paper || '#fff'); ctx.fill();
    ctx.lineWidth = sel ? 2 : 1; ctx.strokeStyle = sel ? (th.selected || '#f08c00') : (exp ? '#9aa3ad' : (th.dimText || '#8a94a3')); ctx.stroke();
    const ink = exp ? '#111418' : (th.ink || '#111418');
    ctx.fillStyle = ink; ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(ellipsis(ctx, v.name, NAME_W - 8), b.x + NAME_W / 2 + 2, b.y + H / 2);
    const ty = b.track.y, kx = b.track.x0 + t * (b.track.x1 - b.track.x0);
    const accent = exp ? '#1f7ad6' : (th.preview || '#1f7ad6');
    ctx.lineCap = 'round'; ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(128,128,128,.28)'; ctx.beginPath(); ctx.moveTo(b.track.x0, ty); ctx.lineTo(b.track.x1, ty); ctx.stroke();
    ctx.strokeStyle = free ? accent : 'rgba(128,128,128,.55)'; ctx.beginPath(); ctx.moveTo(b.track.x0, ty); ctx.lineTo(kx, ty); ctx.stroke();
    ctx.beginPath(); ctx.arc(kx, ty, 7, 0, Math.PI * 2);
    ctx.fillStyle = free ? accent : '#ffffff'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = free ? '#ffffff' : 'rgba(128,128,128,.7)'; ctx.stroke();
    ctx.fillStyle = free ? ink : 'rgba(128,128,128,.9)';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'right';
    const txt = (exp ? `= ` : '') + (Number.isFinite(val) ? fmt(val, sl.step / 10) : '?') + ' ' + unit;
    ctx.fillText(ellipsis(ctx, txt, VALUE_W - 6), b.x + b.w - 8, b.y + H / 2);
    ctx.restore();
    rects.push({ v, b, free });
  }
  r.lastSliderRects = rects;
  return rects;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function ellipsis(ctx, t, w) {
  if (ctx.measureText(t).width <= w) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1);
  return t + '…';
}

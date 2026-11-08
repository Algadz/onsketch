import { PALETTE } from '../core/style.js';
import { INK } from '../render/theme.js';
import { TOOL_ICONS, toolDef } from '../ui/tool-defs.js';

/* =============== SKETCH WINDOW =================================
   Floating window for the freehand side of OnSketch: Pen, Marker and
   Eraser, the ink colour, and size / opacity for the current tool.

   Ink is separate from geometry:
   - strokes live on the active layer (visibility, opacity, order and
     delete follow the layer) and are drawn on top of its shapes;
   - the solver, dimensions, snapping and the Fill tool ignore them;
   - their colour is the ink colour, never the constraint-state colour.
   Settings are per browser (saved with the drawing style).
   ============================================================ */
export const SKETCH_TOOLS = ['fill', 'pen', 'marker', 'eraser'];

/** Size limits in screen pixels, and defaults. */
const LIMITS = { pen: [1, 40], marker: [4, 80], eraser: [4, 120] };
export const INK_DEFAULTS = {
  inkColor: INK,
  penSize: 3, penOpacity: 1,
  markerSize: 18, markerOpacity: 0.4,
  eraserSize: 16,
};

export class SketchWindowMixin {
  /** Size (px) and opacity for one sketch tool. */
  inkSettings(kind) {
    const p = this.pen;
    if (kind === 'marker') return { size: p.markerSize, opacity: p.markerOpacity };
    if (kind === 'eraser') return { size: p.eraserSize, opacity: 1 };
    return { size: p.penSize, opacity: p.penOpacity };
  }

  /** Adds a finished stroke to the active sketch (one undo step). */
  addStroke(stroke) {
    const sketch = this.activeSketch(); if (!sketch || !stroke.points.length) return;
    sketch.strokes.push(stroke);
    this.commit();
    this._refreshLayerPanel();
    this.requestRender();
  }

  /** The tool whose size / opacity the window edits: the active sketch
   *  tool, else the last one used. */
  _sketchTarget() {
    if (SKETCH_TOOLS.includes(this.toolName)) this._lastSketchTool = this.toolName;
    return this._lastSketchTool || 'pen';
  }

  /** Called on every tool change: the Colors window highlights the
   *  colour the new tool uses. */
  _syncColorTarget() {
    if (this.toolName === 'pen' || this.toolName === 'marker') { this.colorTarget = 'ink'; this._lastInkTool = this.toolName; }
    else if (this.toolName === 'fill') this.colorTarget = 'fill';
    this._refreshColorsPanel();
  }

  _refreshSketchWindow() {
    const body = document.getElementById('sketch-body');
    if (!body) return;
    const target = this._sketchTarget();
    const btn = (id) => {
      const t = toolDef(id);
      return `<button class="tool-btn${this.toolName === id ? ' active' : ''}" data-tool="${id}" title="${t.label} (${t.key})" aria-label="${t.label}">${TOOL_ICONS[id]}</button>`;
    };
    let opts;
    if (target === 'fill') {
      opts = `<div class="prop-row"><label>Bucket</label>
        <span class="seg"><button class="${this.fillErase ? '' : 'on'}" data-mode="fill">Fill</button><button class="${this.fillErase ? 'on' : ''}" data-mode="erase">Erase</button></span></div>
        <div class="hint">Click inside a closed area of the active layer to colour it; outside every area colours the background.</div>`;
    } else {
      const s = this.inkSettings(target);
      const [min, max] = LIMITS[target];
      opts = `<div class="prop-row"><label>${toolDef(target).label} size</label>
        <div class="range-row"><input type="range" min="${min}" max="${max}" step="1" value="${s.size}" aria-label="Size"><span>${s.size} px</span></div></div>
        <div class="hint">${target === 'eraser'
          ? 'Removes whole strokes on the active layer. Shapes and fills are not affected.'
          : 'Freehand ink on the active layer. Not solved or dimensioned, and it doesn\'t close areas for the Fill tool.'}</div>`;
    }
    body.innerHTML = `<div class="tool-grid sketch-grid">${SKETCH_TOOLS.map(btn).join('')}</div><div class="tool-sep"></div>${opts}`;

    body.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    body.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => this.setFillErase(b.dataset.mode === 'erase')));
    const r = body.querySelector('input[type=range]');
    if (r) {
      const key = target + 'Size';
      const read = () => { const v = parseFloat(r.value); r.nextElementSibling.textContent = v + ' px'; return v; };
      r.addEventListener('input', () => { this.pen[key] = read(); this.requestRender(); });
      r.addEventListener('change', () => this._setInk({ [key]: read() }));
    }
  }

  setFillErase(on) {
    this.fillErase = !!on;
    this._refreshOptionsBar();
    this._refreshSketchWindow();
    this._updateCanvasCursor();
    if (this.toolName === 'fill') document.getElementById('status-hint').textContent = (this.tool.hint && this.tool.hint()) || '';
  }

  /* ---- Colors window: ink and fill, Paint.NET style ----
     Two chips. The highlighted one is what the palette sets (left click);
     right click sets the other. It follows the tool: Fill highlights Fill,
     Pen and Marker highlight Ink. Click the highlighted chip for any
     colour; ⇄ swaps them. Opacity is the highlighted chip's: the fill
     opacity, or the pen / marker opacity. */
  _colorTarget() { return this.colorTarget === 'ink' ? 'ink' : 'fill'; }
  _inkKind() { return this.toolName === 'marker' || (this.toolName !== 'pen' && this._lastInkTool === 'marker') ? 'marker' : 'pen'; }

  _refreshColorsPanel() {
    const body = document.getElementById('colors-body');
    if (!body) return;
    const p = this.pen;
    const target = this._colorTarget();
    const shown = (c) => c === INK ? 'var(--text)' : c;
    const name = (c) => c === INK ? 'Ink (theme)' : c.toUpperCase();
    const current = target === 'ink' ? p.inkColor : p.fillColor;
    const inkKind = this._inkKind();
    const opacity = target === 'ink' ? this.inkSettings(inkKind).opacity : p.fillOpacity;
    const chip = (which, color, cls) => `
      <label class="pc-sw ${cls}${target === which ? ' active' : ''}" data-chip="${which}" style="--sw:${shown(color)}"
        title="${which === 'ink' ? 'Ink: Pen and Marker' : 'Fill: the Fill tool'}${target === which ? ' (click to choose any colour)' : ''}">
        <input type="color" value="${color}" aria-label="${which === 'ink' ? 'Ink colour' : 'Fill colour'}"></label>`;
    body.innerHTML = `
      <div class="pc-wrap">
        <div class="pc">
          ${chip('ink', p.inkColor, 'pc-primary')}
          ${chip('fill', p.fillColor, 'pc-secondary')}
          <button class="pc-swap" title="Swap ink and fill colours" aria-label="Swap colours">⇄</button>
        </div>
        <div class="pc-legend">
          <span class="${target === 'ink' ? 'on' : ''}"><b>Ink</b> ${name(p.inkColor)}</span>
          <span class="${target === 'fill' ? 'on' : ''}"><b>Fill</b> ${name(p.fillColor)}</span>
        </div>
      </div>
      <div class="palette">
        ${PALETTE.map(c => `<button class="sw${c === current ? ' on' : ''}" data-c="${c}" style="--sw:${c}" title="${c === INK ? 'Ink: black, white on a dark canvas' : c}"></button>`).join('')}
      </div>
      <div class="prop-row"><label>${target === 'ink' ? toolDef(inkKind).label + ' opacity' : 'Fill opacity'}</label>
        <div class="range-row"><input type="range" min="0.05" max="1" step="0.05" value="${opacity}" aria-label="Opacity"><span>${Math.round(opacity * 100)}%</span></div></div>
      <div class="hint">Left click a swatch for the highlighted colour, right click for the other. Line colours show constraint status.</div>`;

    const setColor = (which, c, final = true) => {
      if (which === 'ink') { if (final) this._setInk({ inkColor: c }); else { this.pen.inkColor = c; this.requestRender(); } }
      else this._setPen('fillColor', c, final);
      if (final) this._refreshColorsPanel();
    };
    body.querySelectorAll('[data-chip]').forEach(l => {
      const which = l.dataset.chip, inp = l.querySelector('input');
      l.addEventListener('click', (e) => {
        if (this._colorTarget() !== which) { e.preventDefault(); this.colorTarget = which; this._refreshColorsPanel(); }
      });
      inp.addEventListener('input', () => setColor(which, inp.value, false));
      inp.addEventListener('change', () => setColor(which, inp.value, true));
    });
    body.querySelector('.pc-swap').addEventListener('click', () => {
      const { inkColor, fillColor } = this.pen;
      this.pen.fillColor = inkColor;
      this._setInk({ inkColor: fillColor });
      this._setPen('fillColor', inkColor, true);
    });
    const other = target === 'ink' ? 'fill' : 'ink';
    body.querySelectorAll('.palette .sw').forEach(b => {
      b.addEventListener('click', () => setColor(target, b.dataset.c));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); setColor(other, b.dataset.c); });
    });
    const r = body.querySelector('input[type=range]');
    const key = target === 'ink' ? inkKind + 'Opacity' : 'fillOpacity';
    const read = () => { r.nextElementSibling.textContent = Math.round(r.value * 100) + '%'; return parseFloat(r.value); };
    r.addEventListener('input', () => { this.pen[key] = read(); this.requestRender(); });
    r.addEventListener('change', () => {
      if (target === 'ink') this._setInk({ [key]: read() }); else this._setPen('fillOpacity', read(), true);
    });
  }

  _setInk(changes) {
    Object.assign(this.pen, changes);
    this._savePrefs();
    this._refreshSketchWindow();
    this._refreshColorsPanel();
    this._refreshOptionsBar();
    this._updateCanvasCursor();
    this.requestRender();
  }

  /** Options bar for the sketch tools: size, opacity and ink colour. */
  _sketchOptionsHTML(id) {
    const s = this.inkSettings(id);
    const sep = '<span class="opt-sep"></span>';
    const [min, max] = LIMITS[id];
    let html = sep + `<label class="opt">Size <input type="range" min="${min}" max="${max}" step="1" value="${s.size}" data-ink="${id}Size"><span class="opt-val">${s.size} px</span></label>`;
    if (id !== 'eraser') {
      html += `<label class="opt">Opacity <input type="range" min="0.05" max="1" step="0.05" value="${s.opacity}" data-ink="${id}Opacity"><span class="opt-val">${Math.round(s.opacity * 100)}%</span></label>`;
      const ink = this.pen.inkColor;
      html += `<label class="opt">Ink <i class="opt-sw" style="--sw:${ink === INK ? 'var(--text)' : ink}"></i></label>`;
    }
    html += sep + `<span class="opt-hint">${id === 'eraser' ? 'Drag over strokes to erase them (active layer only).' : 'Drag to draw. Esc cancels the stroke. Alt-drag pans.'}</span>`;
    return html;
  }
  _bindSketchOptions(bar) {
    bar.querySelectorAll('input[data-ink]').forEach(r => {
      const key = r.dataset.ink;
      const read = () => {
        const v = parseFloat(r.value);
        r.nextElementSibling.textContent = key.endsWith('Size') ? v + ' px' : Math.round(v * 100) + '%';
        return v;
      };
      r.addEventListener('input', () => { this.pen[key] = read(); this.requestRender(); });
      r.addEventListener('change', () => { this.pen[key] = read(); this._savePrefs(); this._refreshSketchWindow(); });
    });
  }
}

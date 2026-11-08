import { PALETTE } from '../core/style.js';
import { INK } from '../render/theme.js';
import { TOOL_ICONS, toolDef } from '../ui/tool-defs.js';

/* =============== SKETCH WINDOW =================================
   Floating window for the freehand side of OnSketch: Pen, Marker and
   Eraser, and size / opacity for the current tool (the colour is the
   one shared colour of the Colors window).

   Ink is separate from geometry:
   - strokes live on the active layer (visibility, opacity, order and
     delete follow the layer) and are drawn on top of its shapes;
   - the solver, dimensions, snapping and the Fill tool ignore them;
   - their colour is the shared colour, never the constraint-state colour.
   Settings are per browser (saved with the drawing style).
   ============================================================ */
export const SKETCH_TOOLS = ['fill', 'pen', 'marker', 'eraser'];

/** Size limits in screen pixels, and defaults. */
const LIMITS = { pen: [1, 40], marker: [4, 80], eraser: [4, 120] };
export const INK_DEFAULTS = {
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

  /** Called on every tool change: the Colors window shows the opacity of
   *  the tool now in use. */
  _syncColorTarget() {
    if (this.toolName === 'pen' || this.toolName === 'marker') this._lastInkTool = this.toolName;
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

  /* ---- Colors window: one colour for everything ----
     The Fill tool, the Pen and the Marker all paint with the same colour
     (pen.fillColor). Pick a swatch, or click the chip for any colour. The
     opacity slider is the current tool's: the pen and the marker keep
     their own (a marker is see-through by design); any other tool shows
     the fill opacity. */
  _inkKind() { return this.toolName === 'marker' || (this.toolName !== 'pen' && this._lastInkTool === 'marker') ? 'marker' : 'pen'; }
  _opacityTarget() { return this.toolName === 'pen' || this.toolName === 'marker' ? this.toolName : 'fill'; }

  _refreshColorsPanel() {
    const body = document.getElementById('colors-body');
    if (!body) return;
    const p = this.pen;
    const c = p.fillColor;
    const target = this._opacityTarget();
    const opacity = target === 'fill' ? p.fillOpacity : this.inkSettings(target).opacity;
    body.innerHTML = `
      <div class="pc-wrap">
        <label class="pc-sw pc-one" style="--sw:${c === INK ? 'var(--text)' : c}" title="Colour for Fill, Pen and Marker: click to choose any colour">
          <input type="color" value="${c}" aria-label="Colour"></label>
        <div class="pc-legend"><b>Colour</b><span>${c === INK ? 'Ink (theme)' : c.toUpperCase()}</span></div>
      </div>
      <div class="palette">
        ${PALETTE.map(x => `<button class="sw${x === c ? ' on' : ''}" data-c="${x}" style="--sw:${x}" title="${x === INK ? 'Ink: black, white on a dark canvas' : x}"></button>`).join('')}
      </div>
      <div class="prop-row"><label>${target === 'fill' ? 'Fill' : toolDef(target).label} opacity</label>
        <div class="range-row"><input type="range" min="0.05" max="1" step="0.05" value="${opacity}" aria-label="Opacity"><span>${Math.round(opacity * 100)}%</span></div></div>
      <div class="hint">Used by Fill, Pen and Marker. Line colours show constraint status.</div>`;

    const setColor = (x, final = true) => {
      this._setPen('fillColor', x, final);
      if (final) { this._refreshColorsPanel(); this._refreshOptionsBar(); }
      this.requestRender();
    };
    const inp = body.querySelector('input[type=color]');
    inp.addEventListener('input', () => setColor(inp.value, false));
    inp.addEventListener('change', () => setColor(inp.value, true));
    body.querySelectorAll('.palette .sw').forEach(b => {
      b.addEventListener('click', () => setColor(b.dataset.c));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); setColor(b.dataset.c); });
    });
    const r = body.querySelector('input[type=range]');
    const key = target === 'fill' ? 'fillOpacity' : target + 'Opacity';
    const read = () => { r.nextElementSibling.textContent = Math.round(r.value * 100) + '%'; return parseFloat(r.value); };
    r.addEventListener('input', () => { this.pen[key] = read(); this.requestRender(); });
    r.addEventListener('change', () => {
      if (target === 'fill') this._setPen('fillOpacity', read(), true); else this._setInk({ [key]: read() });
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

  /** Options bar for the sketch tools: size, opacity and the colour. */
  _sketchOptionsHTML(id) {
    const s = this.inkSettings(id);
    const sep = '<span class="opt-sep"></span>';
    const [min, max] = LIMITS[id];
    let html = sep + `<label class="opt">Size <input type="range" min="${min}" max="${max}" step="1" value="${s.size}" data-ink="${id}Size"><span class="opt-val">${s.size} px</span></label>`;
    if (id !== 'eraser') {
      html += `<label class="opt">Opacity <input type="range" min="0.05" max="1" step="0.05" value="${s.opacity}" data-ink="${id}Opacity"><span class="opt-val">${Math.round(s.opacity * 100)}%</span></label>`;
      const ink = this.pen.fillColor;
      html += `<label class="opt">Colour <i class="opt-sw" style="--sw:${ink === INK ? 'var(--text)' : ink}"></i></label>`;
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

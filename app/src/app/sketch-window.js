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
export const SKETCH_TOOLS = ['pen', 'marker', 'eraser'];

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

  _refreshSketchWindow() {
    const body = document.getElementById('sketch-body');
    if (!body) return;
    const p = this.pen;
    const target = this._sketchTarget();
    const s = this.inkSettings(target);
    const [min, max] = LIMITS[target];
    const btn = (id) => {
      const t = toolDef(id);
      return `<button class="tool-btn${this.toolName === id ? ' active' : ''}" data-tool="${id}" title="${t.label} (${t.key})" aria-label="${t.label}">${TOOL_ICONS[id]}</button>`;
    };
    const ink = p.inkColor;
    body.innerHTML = `
      <div class="tool-grid">${SKETCH_TOOLS.map(btn).join('')}</div>
      <div class="tool-sep"></div>
      <div class="ink-row">
        <label class="ink-sw" style="--sw:${ink === INK ? 'var(--text)' : ink}" title="Ink colour: click to choose any colour">
          <input type="color" value="${ink}" aria-label="Ink colour"></label>
        <div class="pc-legend"><b>Ink colour</b><span>${ink === INK ? 'Ink (follows theme)' : ink.toUpperCase()}</span></div>
      </div>
      <div class="palette">
        ${PALETTE.map(c => `<button class="sw${c === ink ? ' on' : ''}" data-c="${c}" style="--sw:${c}" title="${c === INK ? 'Ink: black, white on a dark canvas' : c}"></button>`).join('')}
      </div>
      <div class="prop-row"><label>${toolDef(target).label} size</label>
        <div class="range-row"><input type="range" min="${min}" max="${max}" step="1" value="${s.size}" data-k="size" aria-label="Size"><span>${s.size} px</span></div></div>
      ${target === 'eraser' ? '' : `<div class="prop-row"><label>opacity</label>
        <div class="range-row"><input type="range" min="0.05" max="1" step="0.05" value="${s.opacity}" data-k="opacity" aria-label="Opacity"><span>${Math.round(s.opacity * 100)}%</span></div></div>`}
      <div class="hint">Freehand ink on the active layer. Not solved or dimensioned, and it doesn't close areas for the Fill tool.</div>`;

    body.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    const pick = body.querySelector('input[type=color]');
    pick.addEventListener('input', () => { this.pen.inkColor = pick.value; this.requestRender(); });
    pick.addEventListener('change', () => this._setInk({ inkColor: pick.value }));
    body.querySelectorAll('.palette .sw').forEach(b => b.addEventListener('click', () => this._setInk({ inkColor: b.dataset.c })));
    body.querySelectorAll('input[type=range]').forEach(r => {
      const key = target + (r.dataset.k === 'size' ? 'Size' : 'Opacity');
      const read = () => {
        const v = parseFloat(r.value);
        r.nextElementSibling.textContent = r.dataset.k === 'size' ? v + ' px' : Math.round(v * 100) + '%';
        return v;
      };
      r.addEventListener('input', () => { this.pen[key] = read(); this.requestRender(); });
      r.addEventListener('change', () => this._setInk({ [key]: read() }));
    });
  }

  _setInk(changes) {
    Object.assign(this.pen, changes);
    this._savePrefs();
    this._refreshSketchWindow();
    this._refreshOptionsBar();
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

import { PALETTE } from '../core/style.js';
import { BOX_COLORS, PAPER, cleanBox, isText } from '../core/strokes.js';
import { ARROW_HEADS, ARROW_TIPS, isArrow } from '../core/arrows.js';
import { INK } from '../render/theme.js';
import { TOOL_ICONS, toolDef } from '../ui/tool-defs.js';

/* =============== SKETCH WINDOW =================================
   Floating window for the freehand side of OnSketch: Fill, Pen, Marker,
   Text and Eraser, and the settings of the current tool (the colour is
   the one shared colour of the Colors window).

   Ink is separate from geometry:
   - strokes live on the active layer (visibility, opacity, order and
     delete follow the layer) and are drawn on top of its shapes;
   - the solver, dimensions, snapping and the Fill tool ignore them;
   - their colour is the shared colour, never the constraint-state colour.
   Settings are per browser (saved with the drawing style).
   ============================================================ */
export const SKETCH_TOOLS = ['fill', 'pen', 'marker', 'arrow', 'text', 'eraser'];

/** Size limits in screen pixels, and defaults. */
const LIMITS = { pen: [1, 40], marker: [4, 80], arrow: [1, 16], text: [8, 120], eraser: [4, 120] };
const clampPx = (v, [min, max]) => Math.max(min, Math.min(max, Math.round(v)));

export const INK_DEFAULTS = {
  penSize: 3, penOpacity: 1,
  markerSize: 18, markerOpacity: 0.4,
  eraserSize: 16,
  textSize: 18, textBold: false, textBox: 'none', textBoxColor: PAPER,
  arrowSize: 2, arrowTips: 'end', arrowHead: 'filled', arrowDash: false,
};

export class SketchWindowMixin {
  /** Size (px) and opacity for one sketch tool. */
  inkSettings(kind) {
    const p = this.pen;
    if (kind === 'marker') return { size: p.markerSize, opacity: p.markerOpacity };
    if (kind === 'eraser') return { size: p.eraserSize, opacity: 1 };
    if (kind === 'arrow') {
      return {
        size: p.arrowSize ?? INK_DEFAULTS.arrowSize, opacity: 1,
        tips: ARROW_TIPS.includes(p.arrowTips) ? p.arrowTips : 'end',
        head: ARROW_HEADS.includes(p.arrowHead) ? p.arrowHead : 'filled',
        dash: !!p.arrowDash,
      };
    }
    if (kind === 'text') {
      const mode = ['box', 'outline'].includes(p.textBox) ? p.textBox : 'none';
      return {
        size: p.textSize ?? INK_DEFAULTS.textSize, opacity: 1, bold: !!p.textBold, boxMode: mode,
        box: mode === 'none' ? null : (mode === 'outline' ? { color: p.textBoxColor || PAPER, border: true } : { color: p.textBoxColor || PAPER }),
      };
    }
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

  /* ---- Style of arrows and texts: always editable ----
     The style controls (Sketch window, options bar, Colors) edit the
     selected arrows and texts whenever the Select, Arrow or Text tool is
     in use, and show their current style; with nothing selected they set
     the style of the next one. The change also becomes the setting for
     the next one, so "draw, then pick the style" and "pick the style,
     then draw" both work.
     - a new arrow or text is selected on its own as soon as it is made
       (and a text while it is typed), so it can be restyled right away;
     - with the Arrow tool, a click (no drag) on an arrow selects it;
       with the Text tool, a click on a text edits it;
     - starting the next arrow / text, or Esc, deselects; Delete removes. */

  /** Select only `item` among the ink (geometry selection is kept). */
  setInkCurrent(item) {
    for (const s of this.project.sketches) for (const st of s.strokes) st.selected = false;
    item.selected = true;
    this.refreshUI();
    this.requestRender();
  }

  /** Deselect the selected arrows and texts.
   *  @returns {boolean} whether any were selected */
  releaseInkCurrent() {
    const items = this._styleTargets(true);
    if (!items.length) return false;
    for (const it of items) it.selected = false;
    this.refreshUI();
    this.requestRender();
    return true;
  }

  /** Delete / Backspace in the Arrow or Text tool: removes the selected
   *  arrows and texts (one undo step). @returns {boolean} */
  deleteInkCurrent() {
    const items = new Set(this._styleTargets(true)), sketch = this.activeSketch();
    if (!items.size || !sketch) return false;
    sketch.strokes = sketch.strokes.filter(s => !items.has(s));
    this.commit();
    this.refreshUI();
    this.requestRender();
    return true;
  }

  /** The arrows and texts the style controls edit now: the text being
   *  typed, else the selected ones on the active layer (Select, Arrow and
   *  Text tools only; `anyTool` skips that check). */
  _styleTargets(anyTool = false) {
    if (this._textEdit) return this.toolName === 'text' || anyTool ? [this._textEdit.item] : [];
    if (!anyTool && !['select', 'arrow', 'text'].includes(this.toolName)) return [];
    const sketch = this.activeSketch(); if (!sketch) return [];
    const layerId = this.project.activeLayerId;
    return sketch.strokes.filter(s => s.selected && s.layerId === layerId && (isArrow(s) || isText(s)));
  }

  /** Settings as the controls show them: the style of the first selected
   *  item of that kind, else the settings for the next one. */
  _shownSettings(kind) {
    const s = this.inkSettings(kind);
    if (kind !== 'arrow' && kind !== 'text') return s;
    const it = this._styleTargets().find(x => (kind === 'arrow' ? isArrow(x) : isText(x)));
    if (!it) return s;
    const z = this.view.zoom;
    if (kind === 'arrow') {
      return { ...s, size: clampPx(it.width * z, LIMITS.arrow), tips: it.tips || 'end', head: it.head || 'filled', dash: !!it.dash };
    }
    const boxMode = !it.box ? 'none' : it.box.border ? 'outline' : 'box';
    return { ...s, size: clampPx(it.size * z, LIMITS.text), bold: !!it.bold, boxMode, box: it.box ? { ...it.box } : null };
  }

  /** The colour the Colors window shows: the selection's, when every
   *  selected arrow / text has the same one. */
  _shownColor() {
    const items = this._styleTargets();
    if (items.length && items.every(x => x.color === items[0].color)) return items[0].color;
    return this.pen.fillColor;
  }

  /** Applies changed style settings (pen keys) to the selected arrows and
   *  texts. `final` makes one undo step; otherwise it only redraws (while
   *  a slider is dragged). @returns {boolean} whether something changed */
  _refineInk(changes, final = true) {
    const items = this._styleTargets(); if (!items.length) return false;
    const z = this.view.zoom;
    let hit = false;
    for (const it of items) {
      for (const [k, v] of Object.entries(changes)) {
        if (k === 'fillColor') { it.color = v; hit = true; continue; }
        if (isArrow(it)) {
          if (k === 'arrowSize') it.width = v / z;
          else if (k === 'arrowTips') { if (v === 'end') delete it.tips; else it.tips = v; }
          else if (k === 'arrowHead') { if (v === 'filled') delete it.head; else it.head = v; }
          else if (k === 'arrowDash') { if (v) it.dash = true; else delete it.dash; }
          else continue;
          hit = true;
        } else if (isText(it)) {
          if (k === 'textSize') it.size = v / z;
          else if (k === 'textBold') it.bold = !!v;
          else if (k === 'textBox') {
            if (v === 'none') delete it.box;
            else it.box = cleanBox({ color: it.box?.color || this.pen.textBoxColor || PAPER, border: v === 'outline' });
          } else if (k === 'textBoxColor') {
            it.box = cleanBox({ color: v, border: !!it.box?.border });
          } else continue;
          hit = true;
        }
      }
    }
    if (!hit) return false;
    if (this._textEdit && items.includes(this._textEdit.item)) this._textEdit.place();   // the open editor takes the new look
    const unsaved = this._textEdit && !this.activeSketch()?.strokes.includes(this._textEdit.item);
    if (final && !unsaved) { this.commit(); this._refreshSelectionPanel(); }  // a new text is committed when finished
    this.requestRender();
    return true;
  }

  /** The tool whose size / opacity the window edits: the active sketch
   *  tool, else the last one used. */
  _sketchTarget() {
    if (SKETCH_TOOLS.includes(this.toolName)) this._lastSketchTool = this.toolName;
    const kind = this._selectedStyleKind();
    if (this.toolName === 'select' && kind) return kind;
    return this._lastSketchTool || 'pen';
  }

  /** 'arrow' or 'text' when the selected ink is all arrows or all texts
   *  (a mix with strokes keeps the window as it is). */
  _selectedStyleKind() {
    const items = this._styleTargets();
    if (!items.length) return null;
    const layerId = this.project.activeLayerId;
    if (this.selectedStrokes().some(s => s.layerId === layerId && !isArrow(s) && !isText(s))) return null;
    if (items.every(isArrow)) return 'arrow';
    if (items.every(isText)) return 'text';
    return null;
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
      const s = this._shownSettings(target);
      const [min, max] = LIMITS[target];
      opts = `<div class="prop-row"><label>${toolDef(target).label} size</label>
        <div class="range-row"><input type="range" min="${min}" max="${max}" step="1" value="${s.size}" aria-label="Size"><span>${s.size} px</span></div></div>
        ${target === 'text' ? `<div class="prop-row"><label>Style</label><span class="seg"><button class="${s.bold ? '' : 'on'}" data-bold="0">Regular</button><button class="${s.bold ? 'on' : ''}" data-bold="1"><b>Bold</b></button></span></div>
          <div class="prop-row"><label>Box</label>${boxModeHTML(s.boxMode, 'data-boxmode')}</div>
          ${s.box ? `<div class="prop-row"><label>Box colour</label>${boxSwatchesHTML(s.box.color, 'data-boxcolor')}</div>` : ''}` : ''}
        ${target === 'arrow' ? arrowStyleHTML(s, 'data-arrow', true) : ''}
        <div class="hint">${target === 'eraser'
          ? 'Removes whole strokes and texts on the active layer. Shapes and fills are not affected.'
          : target === 'arrow'
            ? 'Drag from where the arrow starts to what it points at. With Snap on, an end dropped on a shape stays attached to it. Shift: 15° steps.'
          : target === 'text'
            ? 'Click to type a label; click a text to edit it. {D1} or {orbit*2:1} in a text shows a value (click a dimension while typing to insert it). Right-click ink to group it or link it to a shape.'
            : 'Freehand ink on the active layer. Not solved or dimensioned, and it doesn\'t close areas for the Fill tool.'}</div>`;
    }
    body.innerHTML = `<div class="tool-grid sketch-grid">${SKETCH_TOOLS.map(btn).join('')}</div>
      <button class="mini-btn image-import-btn" data-import-image title="Import a PNG, JPEG, WebP or GIF (less than 3 MB), or drop / paste one on the canvas (I)">${IMAGE_ICON}<span>Image…</span></button>
      <div class="tool-sep"></div>${opts}`;
    body.querySelector('[data-import-image]')?.addEventListener('click', () => this.openImagePicker());

    body.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    body.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => this.setFillErase(b.dataset.mode === 'erase')));
    body.querySelectorAll('[data-bold]').forEach(b => b.addEventListener('click', () => this._setInk({ textBold: b.dataset.bold === '1' })));
    body.querySelectorAll('[data-boxmode]').forEach(b => b.addEventListener('click', () => this._setInk({ textBox: b.dataset.boxmode })));
    bindBoxSwatches(body, 'data-boxcolor', (c) => this._setInk({ textBoxColor: c }));
    bindArrowStyle(body, 'data-arrow', (k, v) => this._setInk({ [ARROW_PREF[k]]: v }));
    const r = body.querySelector('input[type=range]');
    if (r) {
      const key = target + 'Size';
      const read = () => { const v = parseFloat(r.value); r.nextElementSibling.textContent = v + ' px'; return v; };
      r.addEventListener('input', () => { this.pen[key] = read(); this._refineInk({ [key]: this.pen[key] }, false); this.requestRender(); });
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
    const c = this._shownColor();
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
      this._refineInk({ fillColor: x }, final);
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
    this._refineInk(changes, true);
    this._savePrefs();
    this._refreshSketchWindow();
    this._refreshColorsPanel();
    this._refreshOptionsBar();
    this._updateCanvasCursor();
    this.requestRender();
  }

  /** Options bar for the sketch tools: size, opacity and the colour. */
  _sketchOptionsHTML(id, restyle = false) {
    const s = this._shownSettings(id);
    const sep = '<span class="opt-sep"></span>';
    const [min, max] = LIMITS[id];
    let html = sep + `<label class="opt">Size <input type="range" min="${min}" max="${max}" step="1" value="${s.size}" data-ink="${id}Size"><span class="opt-val">${s.size} px</span></label>`;
    if (id === 'text') {
      html += `<button class="tbtn toggle${s.bold ? ' on' : ''}" data-opt="text-bold" title="Bold text"><b>B</b><span class="btn-label">Bold</span></button>`;
      html += `<span class="opt">Box ${boxModeHTML(s.boxMode, 'data-opt-boxmode')}</span>`;
      if (s.box) html += `<span class="opt">${boxSwatchesHTML(s.box.color, 'data-opt-boxcolor')}</span>`;
      const ink = this._shownColor();
      html += `<label class="opt">Colour <i class="opt-sw" style="--sw:${ink === INK ? 'var(--text)' : ink}"></i></label>`;
    } else if (id === 'arrow') {
      html += `<span class="opt">${arrowStyleHTML(s, 'data-opt-arrow', false)}</span>`;
      const ink = this._shownColor();
      html += `<label class="opt">Colour <i class="opt-sw" style="--sw:${ink === INK ? 'var(--text)' : ink}"></i></label>`;
    } else if (id !== 'eraser') {
      html += `<label class="opt">Opacity <input type="range" min="0.05" max="1" step="0.05" value="${s.opacity}" data-ink="${id}Opacity"><span class="opt-val">${Math.round(s.opacity * 100)}%</span></label>`;
      const ink = this.pen.fillColor;
      html += `<label class="opt">Colour <i class="opt-sw" style="--sw:${ink === INK ? 'var(--text)' : ink}"></i></label>`;
    }
    const hint = restyle ? `Restyles the selected ${id === 'arrow' ? 'arrows' : 'texts'}; it also sets the style of the next one.`
      : id === 'eraser' ? 'Drag over strokes and texts to erase them (active layer only).'
      : id === 'text' ? 'Click to place text, Enter to finish, Shift+Enter for a new line. {D1} shows a value. Click a text to edit it.'
      : id === 'arrow' ? `Drag to what you point at. Ends snap to shapes and stay attached. Shift: 15° steps.${this.touchUI ? '' : ` ${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌥ Option' : 'Alt'}: no snap.`}`
        : 'Drag to draw. Esc cancels the stroke. Space-drag pans.';
    html += sep + `<span class="opt-hint">${hint}</span>`;
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
      r.addEventListener('input', () => { this.pen[key] = read(); this._refineInk({ [key]: this.pen[key] }, false); this.requestRender(); });
      r.addEventListener('change', () => { this.pen[key] = read(); this._refineInk({ [key]: this.pen[key] }, true); this._savePrefs(); this._refreshSketchWindow(); });
    });
    bar.querySelector('[data-opt="text-bold"]')?.addEventListener('click', () => this._setInk({ textBold: !this.pen.textBold }));
    bar.querySelectorAll('[data-opt-boxmode]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); this._setInk({ textBox: b.dataset.optBoxmode }); }));
    bindBoxSwatches(bar, 'data-opt-boxcolor', (c) => this._setInk({ textBoxColor: c }));
    bindArrowStyle(bar, 'data-opt-arrow', (k, v) => this._setInk({ [ARROW_PREF[k]]: v }));
  }
}

const IMAGE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4.5 18l5-5 3.5 3.5 2.5-2.5 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/* ---- Arrow style controls (Sketch window, options bar, Properties) ----
   Three small segmented rows with drawn glyphs: which ends have a head
   (tip only, both, none), the head (filled, open, dot) and the line
   (solid, dashed). `s` holds tips / head / dash; null means mixed. */
const ARROW_PREF = { tips: 'arrowTips', head: 'arrowHead', dash: 'arrowDash' };
const g = (d) => `<svg viewBox="0 0 28 12" width="28" height="12" aria-hidden="true">${d}</svg>`;
const ARROW_OPTIONS = {
  tips: [
    ['end', g('<path d="M3 6h17" stroke="currentColor" stroke-width="1.6"/><path d="M18 2.5 25 6l-7 3.5z" fill="currentColor"/>'), 'Head at the tip'],
    ['both', g('<path d="M8 6h12" stroke="currentColor" stroke-width="1.6"/><path d="M18 2.5 25 6l-7 3.5zM10 2.5 3 6l7 3.5z" fill="currentColor"/>'), 'Heads at both ends'],
    ['none', g('<path d="M3 6h22" stroke="currentColor" stroke-width="1.6"/>'), 'No head (a leader line)'],
  ],
  head: [
    ['filled', g('<path d="M3 6h14" stroke="currentColor" stroke-width="1.6"/><path d="M16 1.5 25 6l-9 4.5z" fill="currentColor"/>'), 'Filled head'],
    ['open', g('<path d="M3 6h21M16 1.5 24.5 6 16 10.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>'), 'Open head'],
    ['dot', g('<path d="M3 6h16" stroke="currentColor" stroke-width="1.6"/><circle cx="21" cy="6" r="3.6" fill="currentColor"/>'), 'Dot (for leaders pointing at a surface)'],
  ],
  dash: [
    [false, g('<path d="M3 6h22" stroke="currentColor" stroke-width="1.6"/>'), 'Solid line'],
    [true, g('<path d="M3 6h22" stroke="currentColor" stroke-width="1.6" stroke-dasharray="4 3"/>'), 'Dashed line'],
  ],
};

export function arrowStyleHTML(s, attr, rows) {
  const seg = (k) => `<span class="seg arrow-seg">${ARROW_OPTIONS[k].map(([v, glyph, title]) =>
    `<button class="${s[k] === v ? 'on' : ''}" ${attr}="${k}:${v}" title="${title}" aria-label="${title}">${glyph}</button>`).join('')}</span>`;
  if (!rows) return seg('tips') + seg('head') + seg('dash');
  return `<div class="prop-row"><label>Ends</label>${seg('tips')}</div>
    <div class="prop-row"><label>Head</label>${seg('head')}</div>
    <div class="prop-row"><label>Line</label>${seg('dash')}</div>`;
}

export function bindArrowStyle(root, attr, set) {
  root.querySelectorAll(`[${attr}]`).forEach(b => b.addEventListener('click', (e) => {
    e.preventDefault();
    const [k, v] = b.getAttribute(attr).split(':');
    set(k, k === 'dash' ? v === 'true' : v);
  }));
}

/* ---- Text box controls (Sketch window, options bar, Properties) ----
   Box: None · Box · Outlined (the outline is in the text colour), and a
   row of box colours: Paper (the canvas colour, so a label masks the
   lines behind it in both themes), light tints that keep any text colour
   readable, and a picker for any colour. */
const BOX_MODES = [['none', 'None', 'No box'], ['box', 'Box', 'A filled box behind the text'], ['outline', 'Outlined', 'A filled box with an outline in the text colour']];

export function boxModeHTML(mode, attr) {
  return `<span class="seg">${BOX_MODES.map(([id, label, title]) =>
    `<button class="${mode === id ? 'on' : ''}" ${attr}="${id}" title="${title}">${label}</button>`).join('')}</span>`;
}

/** `current` may be null (mixed). */
export function boxSwatchesHTML(current, attr) {
  const custom = current && current !== PAPER && !BOX_COLORS.includes(current) ? current : null;
  return `<span class="box-swatches">${BOX_COLORS.map(c =>
    `<button class="bsw${c === current ? ' on' : ''}${c === PAPER ? ' paper' : ''}" ${attr}="${c}" style="--sw:${c === PAPER ? 'var(--canvas-a)' : c}" title="${c === PAPER ? 'Paper: the canvas colour (hides the lines behind the text)' : c}"></button>`).join('')}`
    + `<label class="bsw custom${custom ? ' on' : ''}" style="--sw:${custom || 'transparent'}" title="Any colour"><input type="color" ${attr}="custom" value="${custom || '#ffffff'}" aria-label="Box colour"></label></span>`;
}

export function bindBoxSwatches(root, attr, set) {
  root.querySelectorAll(`button[${attr}]`).forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); set(b.getAttribute(attr)); }));
  const inp = root.querySelector(`input[${attr}="custom"]`);
  if (inp) inp.addEventListener('change', () => set(inp.value));
}

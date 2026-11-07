import { LINE_STYLES, LINE_WEIGHTS, PALETTE } from '../core/style.js';
import { clamp } from '../core/math.js';
import { ACTION_ICONS, DRAW_TOOLS, TOOLS, TOOL_ICONS, WINDOW_ICONS, toolDef } from '../ui/tool-defs.js';
import { WindowManager } from '../ui/windows.js';

/* =============== APP CHROME ====================================
   Menu bar, tool options bar, and the floating Tools and Colors
   windows (Layers and Properties content live in layers-panel.js
   and panels.js).

   Line colours always show state (as in SolidWorks); the only colour
   picked here is the Fill tool's. New geometry takes the current line
   weight and line type; existing geometry changes only through an
   explicit "Apply line style" on the selection.
   ============================================================ */
export class ChromeMixin {
  _setupChrome() {
    // Menu bar icons + labels.
    const labels = { grid: 'Grid', snap: 'Snap', dimensions: 'Dimensions' };
    document.querySelectorAll('#menubar [data-action]').forEach(b => {
      const a = b.dataset.action;
      b.innerHTML = (ACTION_ICONS[a] || '') + (labels[a] ? `<span class="btn-label">${labels[a]}</span>` : '');
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => this._runAction(a, b));
    });
    document.querySelectorAll('#menubar [data-window]').forEach(b => {
      b.innerHTML = WINDOW_ICONS[b.dataset.window];
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => this.windows.toggle(b.dataset.window));
    });

    this._buildToolsWindow();

    const ws = document.getElementById('workspace');
    this.windows = new WindowManager(ws, {
      tools:  (cw, ch, w) => ({ x: 12, y: 12 }),
      colors: (cw, ch, w, h) => ({ x: 12, y: Math.max(12, ch - h - 12) }),
      layers: (cw, ch, w) => ({ x: cw - w - 12, y: 12 }),
      props:  (cw, ch, w) => ({ x: cw - w - 12, y: 212 }),
      equations: (cw, ch, w) => ({ x: Math.max(160, (cw - w) / 2), y: 60 }),   // below the lock banner
    }, () => this._syncWindowButtons());
    this._syncWindowButtons();
    requestAnimationFrame(() => this.windows.layout());
  }

  _runAction(a, b) {
    switch (a) {
      case 'new':          this.newProject(); break;
      case 'save':         this.saveLocal(); break;
      case 'export':       this.exportJSON(); break;
      case 'import':       this.importJSON(); break;
      case 'undo':         this.undo(); break;
      case 'redo':         this.redo(); break;
      case 'solve':        this.solveAndRender(); break;
      case 'mirror':       this.startMirrorOperation(); break;
      case 'offset':       this.startOffsetOperation(); break;
      case 'construction': this.constructionMode = !this.constructionMode; this._refreshOptionsBar(); break;
      case 'grid':         this.gridOn = !this.gridOn; b?.classList.toggle('on', this.gridOn); this.requestRender(); break;
      case 'snap':         this.snapOn = !this.snapOn; b?.classList.toggle('on', this.snapOn); this.requestRender(); break;
      case 'dimensions':   this.setDimensionsVisible(!this.showDimensions); break;
      case 'zoom-fit':     this.zoomFit(); break;
      case 'zoom-reset':   this.view.zoom = 4; this.view.panX = 0; this.view.panY = 0; this.requestRender(); break;
      case 'theme':        this.setTheme(this.themeName === 'dark' ? 'light' : 'dark'); break;
      case 'reset-layout': this.windows.reset(); break;
      case 'apply-style':  this.applyDrawingStyleToSelection(); break;
      case 'pick-style':   this.pickStyleFromSelection(); break;
    }
  }

  _syncWindowButtons() {
    document.querySelectorAll('#menubar [data-window]').forEach(b =>
      b.classList.toggle('on', this.windows.isOpen(b.dataset.window)));
  }

  /* ---- Dimensions visibility ---- */
  setDimensionsVisible(on, save = true) {
    this.showDimensions = !!on;
    document.querySelector('#menubar [data-action="dimensions"]')?.classList.toggle('on', this.showDimensions);
    if (!this.showDimensions) this.renderer.lastDimRects = [];
    if (save) this._savePrefs();
    this.requestRender();
  }

  /* ---- Tools window ---- */
  _buildToolsWindow() {
    const body = document.getElementById('tools-body');
    const btn = (t) => `<button class="tool-btn" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}">${TOOL_ICONS[t.id]}</button>`;
    const group = (g) => TOOLS.filter(t => t.group === g).map(btn).join('');
    const dim = toolDef('smartdim');
    body.innerHTML = `
      <div class="tool-grid">${group('pick')}${group('paint')}</div>
      <div class="tool-sep"></div>
      <div class="tool-grid">${group('sketch')}</div>
      <div class="tool-sep"></div>
      <button class="tool-btn tool-wide tool-dim" data-tool="smartdim" title="${dim.label} (${dim.key}): click one or two entities, then click to place" aria-label="${dim.label}">
        ${TOOL_ICONS.smartdim}<span>Dimension</span></button>
      <div class="tool-sep"></div>
      <div class="tool-grid">
        <button class="tool-btn" data-action="mirror" title="Mirror selection about a line">${ACTION_ICONS.mirror}</button>
        <button class="tool-btn" data-action="offset" title="Offset selected line, circle or arc">${ACTION_ICONS.offset}</button>
      </div>`;
    body.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    body.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => this._runAction(b.dataset.action, b)));
  }

  /** Colors window: the fill colour the Fill tool paints with. Stroke
   *  colour isn't chosen; lines always show their state. */
  _refreshColorsPanel() {
    const body = document.getElementById('colors-body');
    if (!body) return;
    const p = this.pen;
    body.innerHTML = `
      <div class="pc-wrap">
        <label class="pc-sw pc-fill" style="--sw:${p.fillColor}" title="Fill colour: click to choose any colour">
          <input type="color" value="${p.fillColor}" data-pen="fillColor"></label>
        <div class="pc-legend"><b>Fill colour</b><span>${p.fillColor.toUpperCase()}</span></div>
      </div>
      <div class="palette">
        ${PALETTE.map(c => `<button class="sw${c === p.fillColor ? ' on' : ''}" data-c="${c}" style="--sw:${c}" title="${c}"></button>`).join('')}
      </div>
      <div class="prop-row"><label>opacity</label>
        <div class="range-row"><input type="range" min="0.05" max="1" step="0.05" value="${p.fillOpacity}" data-pen="fillOpacity"><span>${Math.round(p.fillOpacity * 100)}%</span></div></div>
      <div class="hint">Used by the Fill tool (B). Line colours show constraint status.</div>`;
    const inp = body.querySelector('input[type=color]');
    inp.addEventListener('input', () => this._setPen('fillColor', inp.value, false));
    inp.addEventListener('change', () => this._setPen('fillColor', inp.value, true));
    body.querySelectorAll('.palette .sw').forEach(b => {
      b.addEventListener('click', () => this._setPen('fillColor', b.dataset.c, true));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this._setPen('fillColor', b.dataset.c, true); });
    });
    const r = body.querySelector('input[type=range]');
    const read = () => { r.nextElementSibling.textContent = Math.round(r.value * 100) + '%'; return parseFloat(r.value); };
    r.addEventListener('input', () => this._setPen('fillOpacity', read(), false));
    r.addEventListener('change', () => this._setPen('fillOpacity', read(), true));
  }



  _setPen(key, value, final) {
    this.pen[key] = value;
    this._penChanged(final);
    if (key === 'fillColor') this._updateCanvasCursor();
    if (final) this._refreshPenUI();
  }
  _refreshPenUI() {
    this._refreshColorsPanel();
    this._refreshOptionsBar();
    if (this.toolName === 'fill') this.refreshToolOptions();
  }

  /* ---- Tool options bar ---- */
  _refreshOptionsBar() {
    const bar = document.getElementById('optbar');
    if (!bar) return;
    const t = toolDef(this.toolName);
    const p = this.pen;
    let html = `<span class="opt-tool">${TOOL_ICONS[t.id] || ''}<b>${t.label}</b></span>`;
    const sep = '<span class="opt-sep"></span>';
    if (DRAW_TOOLS.has(t.id)) {
      html += sep + `<label class="opt">Weight <select data-pen="lineWidth">${LINE_WEIGHTS.map(w => `<option value="${w}"${p.lineWidth === w ? ' selected' : ''}>${w} px</option>`).join('')}</select></label>`;
      html += `<label class="opt">Line <select data-pen="lineStyle">${Object.entries(LINE_STYLES).map(([k, v]) => `<option value="${k}"${p.lineStyle === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>`;
      html += sep + `<button class="tbtn toggle${this.constructionMode ? ' on' : ''}" data-opt="construction" title="Draw construction (reference) geometry">${ACTION_ICONS.construction}<span class="btn-label">Construction</span></button>`;
      if (t.id === 'hexagon') {
        html += sep + `<label class="opt">Sides <input type="number" min="3" max="64" step="1" value="${this.polygonSides}" data-opt="sides"></label>`;
      }
    } else if (t.id === 'select') {
      html += sep + `<button class="tbtn" data-opt="mirror">${ACTION_ICONS.mirror}<span class="btn-label">Mirror</span></button>`;
      html += `<button class="tbtn" data-opt="offset">${ACTION_ICONS.offset}<span class="btn-label">Offset</span></button>`;
      html += sep + `<button class="tbtn" data-opt="apply-style" title="Give the selected entities the current line weight and line type">${ACTION_ICONS['apply-style']}<span class="btn-label">Apply line style</span></button>`;
      html += `<button class="tbtn" data-opt="pick-style" title="Copy the selected entity's line weight and line type">${ACTION_ICONS['pick-style']}<span class="btn-label">Pick line style</span></button>`;
      html += sep + '<span class="opt-hint">Click to select, Ctrl-click to add, drag a box to select many, drag geometry to move it.</span>';
    } else if (t.id === 'smartdim') {
      html += sep + '<span class="opt-hint"><b>1.</b> Click one or two entities &nbsp; <b>2.</b> Click to place the dimension &nbsp; <b>3.</b> Type a value, Enter. Click an existing dimension to edit it.</span>';
    } else if (t.id === 'fill') {
      html += sep + `<span class="seg"><button class="${this.fillErase ? '' : 'on'}" data-opt="fill-mode">Fill</button><button class="${this.fillErase ? 'on' : ''}" data-opt="erase-mode">Erase fill</button></span>`;
      html += `<label class="opt">Colour <i class="opt-sw" style="--sw:${p.fillColor}"></i></label>`;
      html += sep + '<span class="opt-hint">Click an area of the active layer: a region closed by its shapes is filled; anywhere else fills the background. Other layers are ignored.</span>';
    }
    bar.innerHTML = html;

    bar.querySelectorAll('select[data-pen]').forEach(sel => sel.addEventListener('change', () => {
      const k = sel.dataset.pen;
      const v = k === 'lineWidth' ? parseFloat(sel.value) : sel.value;
      this._setPen(k, v, true);
    }));
    bar.querySelectorAll('[data-opt]').forEach(el => {
      const k = el.dataset.opt;
      if (k === 'sides') {
        el.addEventListener('input', () => {
          const n = Math.round(parseFloat(el.value));
          if (!Number.isFinite(n)) return;
          this.polygonSides = clamp(n, 3, 64);
          this.requestRender();
        });
        return;
      }
      el.addEventListener('click', () => {
        if (k === 'construction') this._runAction('construction');
        else if (k === 'fill-mode' || k === 'erase-mode') {
          this.fillErase = k === 'erase-mode';
          this._refreshOptionsBar();
          this._updateCanvasCursor();
          document.getElementById('status-hint').textContent = (this.tool.hint && this.tool.hint()) || '';
        } else this._runAction(k);
      });
    });
  }

  /* ---- Style ↔ selection, only on request ---- */
  _selectedTopEntities() {
    const out = [];
    for (const s of this.project.sketches) for (const e of s.entities) if (e.selected) out.push(e);
    return out;
  }
  applyDrawingStyleToSelection() {
    const targets = this._selectedTopEntities();
    if (!targets.length) { document.getElementById('status-hint').textContent = 'Select entities first, then Apply line style.'; return; }
    const st = this._penStyle();
    for (const e of targets) e.style = st ? { ...st } : null;
    this.commit();
    this.refreshUI();
  }
  pickStyleFromSelection() {
    const e = this._selectedTopEntities()[0];
    if (!e || !e.style) return;
    const s = e.style;
    if (s.lineWidth) this.pen.lineWidth = s.lineWidth;
    if (s.lineStyle) this.pen.lineStyle = s.lineStyle;
    this._penChanged();
    this._refreshPenUI();
  }
}

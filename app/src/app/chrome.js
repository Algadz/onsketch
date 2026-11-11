import { LINE_STYLES, LINE_WEIGHTS } from '../core/style.js';
import { clamp } from '../core/math.js';
import { ACTION_ICONS, DRAW_TOOLS, TOOLS, TOOL_ICONS, WINDOW_ICONS, toolDef } from '../ui/tool-defs.js';
import { WindowManager } from '../ui/windows.js';

/** Name of the Alt key on this platform (Option on a Mac). */
export const ALT_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌥ Option' : 'Alt';

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
    const labels = { new: 'New', open: 'Open', save: 'Save', grid: 'Grid', snap: 'Snap', dimensions: 'Dimensions', relations: 'Relations' };
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
      sketch: () => {                                   // to the right of the Tools window
        const t = document.querySelector('.fwin[data-win="tools"]');
        return { x: t && !t.hidden ? t.offsetLeft + t.offsetWidth + 8 : 12, y: 12 };
      },
    }, () => { this._syncWindowButtons(); if (this.compact) this._renderMobileBar(); });
    this._syncWindowButtons();
    requestAnimationFrame(() => this.windows.layout());
  }

  _runAction(a, b) {
    switch (a) {
      case 'new':          this.newProject(); break;
      case 'save':         this.save(); break;
      case 'open':         this.openSketch?.(); break;
      case 'undo':         this.undo(); break;
      case 'redo':         this.redo(); break;
      case 'solve':        this.solveAndRender(); break;
      case 'mirror':       this.startMirrorOperation(); break;
      case 'offset':       this.startOffsetOperation(); break;
      case 'construction': this.constructionMode = !this.constructionMode; this._refreshOptionsBar(); break;
      case 'grid':         this.setGridVisible(!this.gridOn); break;
      case 'snap':         this.setSnapOn(!this.snapOn); break;
      case 'dimensions':   this.setDimensionsVisible(!this.showDimensions); break;
      case 'relations':    this.setRelationsVisible(!this.showRelations); break;
      case 'zoom-fit':     this.zoomFit(); break;
      case 'zoom-reset':   this.view.zoom = 4; this.view.panX = 0; this.view.panY = 0; this.requestRender(); break;
      case 'theme':        this.setTheme(this.themeName === 'dark' ? 'light' : 'dark'); break;
      case 'reset-layout': this.windows.reset(); break;
      case 'account':      this.openAccount(); break;
      case 'my-sketches':  location.href = 'projects/'; break;
      case 'library':      location.href = '/library/'; break;
      case 'profile':      this.editProfile(); break;
      case 'signout':      this.cloudSignOut(); break;
      case 'pricing':      location.href = '/pricing/'; break;
      case 'billing':      this.manageSubscription(); break;
    }
  }

  _syncWindowButtons() {
    document.querySelectorAll('#menubar [data-window]').forEach(b =>
      b.classList.toggle('on', this.windows.isOpen(b.dataset.window)));
  }

  /* ---- Display: grid, snap, dimensions, relations, dimension names ----
     Saved with the project (project.display), so a drawing opens the way
     it was left, on any device. Also remembered in the browser as the
     setup for new drawings and for files saved before this existed.
     `save` false: applying a setup (loading), nothing to store. */
  displaySettings() {
    return {
      grid: !!this.gridOn, snap: !!this.snapOn,
      dimensions: this.showDimensions !== false, relations: this.showRelations !== false,
      dimNames: !!this.showDimNames,
    };
  }

  applyDisplay(d) {
    this.setGridVisible(d.grid, false);
    this.setSnapOn(d.snap, false);
    this.setDimensionsVisible(d.dimensions, false);
    this.setRelationsVisible(d.relations, false);
    this.showDimNames = !!d.dimNames;
    this._refreshEquationsPanel?.();
    this._refreshMoreMenu?.();
  }

  /** A display toggle changed: into the project (saved like an edit, but
   *  not an undo step) and into the browser preferences. */
  _displayChanged() {
    if (this._displayReady && this.project) {
      this.project.display = this.displaySettings();
      this.scheduleAutosave();
    }
    this._savePrefs();
  }

  setGridVisible(on, save = true) {
    this.gridOn = !!on;
    document.querySelector('#menubar [data-action="grid"]')?.classList.toggle('on', this.gridOn);
    if (save) this._displayChanged();
    this.requestRender();
  }

  setSnapOn(on, save = true) {
    this.snapOn = !!on;
    document.querySelector('#menubar [data-action="snap"]')?.classList.toggle('on', this.snapOn);
    if (!this.snapOn) { this.lastSnap = null; this.lastDragSnaps = []; }
    if (save) this._displayChanged();
    this.requestRender();
  }

  setRelationsVisible(on, save = true) {
    this.showRelations = !!on;
    document.querySelector('#menubar [data-action="relations"]')?.classList.toggle('on', this.showRelations);
    if (!this.showRelations) this.renderer.lastRelRects = [];
    if (save) this._displayChanged();
    this.requestRender();
  }

  setDimensionsVisible(on, save = true) {
    this.showDimensions = !!on;
    document.querySelector('#menubar [data-action="dimensions"]')?.classList.toggle('on', this.showDimensions);
    if (!this.showDimensions) this.renderer.lastDimRects = [];
    if (save) this._displayChanged();
    this.requestRender();
  }

  /* ---- Tools window ---- */
  _buildToolsWindow() {
    const body = document.getElementById('tools-body');
    const btn = (t) => `<button class="tool-btn" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}">${TOOL_ICONS[t.id]}</button>`;
    const group = (g) => TOOLS.filter(t => t.group === g).map(btn).join('');
    const dim = toolDef('smartdim');
    body.innerHTML = `
      <div class="tool-grid">${group('pick')}</div>
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
      if (!this.touchUI) html += sep + `<span class="opt-hint"><kbd>${ALT_KEY}</kbd> place without snapping</span>`;
    } else if (t.id === 'select') {
      const kind = this._selectedStyleKind?.();          // selected arrows or texts: their style, editable here
      html += kind ? this._sketchOptionsHTML(kind, true)
        : sep + `<span class="opt-hint">Click to select, Ctrl-click to add, drag a box to select many, drag geometry to move it${this.touchUI ? '' : ` (<kbd>${ALT_KEY}</kbd> without snapping)`}.</span>`;
    } else if (t.id === 'smartdim') {
      html += sep + '<span class="opt-hint"><b>1.</b> Click one or two entities &nbsp; <b>2.</b> Click to place the dimension &nbsp; <b>3.</b> Type a value, Enter. Click an existing dimension to edit it.</span>';
    } else if (t.group === 'freehand') {
      html += this._sketchOptionsHTML(t.id);
    } else if (t.id === 'fill') {
      html += sep + `<span class="seg"><button class="${this.fillErase ? '' : 'on'}" data-opt="fill-mode">Fill</button><button class="${this.fillErase ? 'on' : ''}" data-opt="erase-mode">Erase fill</button></span>`;
      html += `<label class="opt">Colour <i class="opt-sw" style="--sw:${p.fillColor}"></i></label>`;
      html += sep + '<span class="opt-hint">Click an area of the active layer: a region closed by its shapes is filled; anywhere else fills the background. Other layers are ignored.</span>';
    }
    html += this._touchOptionsHTML(t);          // touch only (touch-ui.js)
    bar.innerHTML = html;

    this._bindSketchOptions(bar);
    this._bindTouchOptions(bar);
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
        else if (k === 'fill-mode' || k === 'erase-mode') this.setFillErase(k === 'erase-mode');
        else this._runAction(k);
      });
    });
  }

  /** Selected top-level shapes (lines, circles, arcs, points). */
  _selectedTopEntities() {
    const out = [];
    for (const s of this.project.sketches) for (const e of s.entities) if (e.selected) out.push(e);
    return out;
  }
}

import { LINE_STYLES, LINE_WEIGHTS, PALETTE, cleanStyle, resolveStyle } from '../core/style.js';
import { getTheme, INK } from '../render/theme.js';
import { uiIcon } from '../ui/icons.js';

const PREFS_KEY = 'onsketch:prefs';
const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Drawing style used by the tools, like Paint.NET's palette: stroke
 *  (primary) and fill (secondary) colours plus line settings. */
const DEFAULT_PEN = {
  color: INK, lineWidth: 1.4, lineStyle: 'solid',
  fillColor: '#1f7ad6', fillOpacity: 0.35, fillShapes: false,
};

/* =============== LAYERS + STYLE PANELS =========================
   Right-hand sidebar. "Layers" lists project layers top-most first
   (as in Paint.NET): visibility, lock, opacity, order. Layers carry no
   colours of their own.

   "Style" edits the drawing style the tools use for the next shapes
   (and the fill tool's colour), or the selected entities' style when
   something is selected. Also owns view preferences: theme and colour
   mode.
   ============================================================ */
export class LayersPanelMixin {
  _setupLayersPanel() {
    const btn = (id, icon, fn) => {
      const b = document.getElementById(id);
      b.innerHTML = uiIcon(icon);
      b.addEventListener('click', fn);
    };
    btn('layer-add', 'plus', () => {
      this.project.addLayer();
      this.clearSelection();
      this._layerChanged();
    });
    btn('layer-up', 'up', () => { if (this.project.moveLayer(this.project.activeLayerId, +1)) this._layerChanged(); });
    btn('layer-down', 'down', () => { if (this.project.moveLayer(this.project.activeLayerId, -1)) this._layerChanged(); });
    btn('layer-delete', 'trash', () => {
      const layer = this.project.activeLayer();
      if (this.project.layers.length <= 1) return alert('A project needs at least one layer.');
      const n = this.project.entitiesOnLayer(layer.id).length;
      if (!confirm(n ? `Delete layer "${layer.name}" and its ${n} entit${n === 1 ? 'y' : 'ies'}?` : `Delete layer "${layer.name}"?`)) return;
      this.project.removeLayer(layer.id);
      this.clearSelection();
      this._layerChanged();
    });
    this._loadPrefs();
  }

  /* ---- Preferences (per browser, not part of the project) ---- */
  _loadPrefs() {
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { prefs = {}; }
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.pen = { ...DEFAULT_PEN, ...(prefs.pen || {}) };
    this.fillErase = false;
    this._penChanged(false);
    this.setTheme(prefs.theme || (systemDark ? 'dark' : 'light'), false);
    this.setColorMode(prefs.colorMode === 'status' ? 'status' : 'style', false);
  }
  _savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: this.themeName, colorMode: this.colorMode, pen: this.pen }));
    } catch { /* storage unavailable */ }
  }
  setTheme(name, save = true) {
    this.themeName = name === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = this.themeName;
    this.renderer.theme = getTheme(this.themeName);
    const b = document.querySelector('#topbar [data-action="theme"]');
    if (b) b.innerHTML = uiIcon(this.themeName === 'dark' ? 'sun' : 'moon').replace('class="ui-icon"', '');
    if (save) this._savePrefs();
    this.requestRender();
  }
  setColorMode(mode, save = true) {
    this.colorMode = mode === 'status' ? 'status' : 'style';
    this.renderer.colorMode = this.colorMode;
    const b = document.querySelector('#topbar [data-action="color-mode"]');
    if (b) b.classList.toggle('on', this.colorMode === 'status');
    const label = document.getElementById('color-mode-label');
    if (label) label.textContent = this.colorMode === 'status' ? 'Status' : 'Colors';
    if (save) this._savePrefs();
    this.requestRender();
  }

  /** Entity style handed to new geometry. */
  _penStyle() {
    const p = this.pen;
    const st = { color: p.color, lineWidth: p.lineWidth, lineStyle: p.lineStyle };
    if (p.fillShapes) { st.fill = p.fillColor; st.fillOpacity = p.fillOpacity; }
    return cleanStyle(st);
  }
  _penChanged(save = true) {
    if (this.project) this.project.drawStyle = this._penStyle();
    if (save) this._savePrefs();
  }

  _layerChanged() {
    this.commit();
    this.refreshUI();
    this.requestRender();
  }

  /* ---- Layers list ---- */
  _refreshLayerPanel() {
    const list = document.getElementById('layer-list');
    if (!list) return;
    const project = this.project;
    const counts = new Map();
    for (const s of project.sketches) for (const e of s.entities) counts.set(e.layerId, (counts.get(e.layerId) || 0) + 1);
    list.innerHTML = '';
    for (const layer of [...project.layers].reverse()) {
      const row = document.createElement('div');
      row.className = 'lyr-row' + (layer.id === project.activeLayerId ? ' active' : '') + (layer.visible ? '' : ' hidden-layer');
      row.dataset.layerId = layer.id;
      row.innerHTML = `
        <button class="icon-btn" data-k="vis" title="${layer.visible ? 'Hide' : 'Show'} layer" aria-label="Toggle visibility">${uiIcon(layer.visible ? 'eye' : 'eyeOff')}</button>
        <button class="icon-btn${layer.locked ? ' on' : ''}" data-k="lock" title="${layer.locked ? 'Unlock' : 'Lock'} layer (locked geometry never moves)" aria-label="Toggle lock">${uiIcon(layer.locked ? 'lock' : 'unlock')}</button>
        <span class="name" title="Double-click to rename">${esc(layer.name)}</span>
        <span class="count">${counts.get(layer.id) || 0}</span>`;
      row.querySelector('[data-k="vis"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        layer.visible = !layer.visible;
        if (!layer.visible) this._deselectLayer(layer.id);
        this._layerChanged();
      });
      row.querySelector('[data-k="lock"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        layer.locked = !layer.locked;
        if (layer.locked) this._deselectLayer(layer.id);
        this._layerChanged();
      });
      const name = row.querySelector('.name');
      name.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        name.setAttribute('contenteditable', 'true');
        name.focus();
        const range = document.createRange(); range.selectNodeContents(name);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        const finish = () => {
          name.removeAttribute('contenteditable');
          name.removeEventListener('blur', finish);
          const v = name.textContent.trim();
          if (v && v !== layer.name) { layer.name = v; this._layerChanged(); } else this.refreshUI();
        };
        name.addEventListener('blur', finish);
        name.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
          if (e.key === 'Escape') { name.textContent = layer.name; name.blur(); }
        });
      });
      row.addEventListener('click', () => {
        if (project.activeLayerId === layer.id) return;
        project.activeLayerId = layer.id;
        this.clearSelection();          // selection is limited to the active layer
      });
      list.appendChild(row);
    }

    // Active layer opacity.
    const props = document.getElementById('layer-props');
    if (props) {
      const layer = project.activeLayer();
      props.innerHTML = `<div class="prop-row"><label>opacity</label>
        <div class="range-row"><input type="range" min="0" max="1" step="0.05" value="${layer.opacity}" aria-label="Layer opacity"><span>${Math.round(layer.opacity * 100)}%</span></div></div>`;
      const r = props.querySelector('input');
      const read = () => { r.nextElementSibling.textContent = Math.round(r.value * 100) + '%'; return parseFloat(r.value); };
      r.addEventListener('input', () => { layer.opacity = read(); this.requestRender(); });
      r.addEventListener('change', () => { layer.opacity = read(); this._layerChanged(); });
    }
    const status = document.getElementById('status-layer');
    if (status) status.textContent = 'Layer: ' + project.activeLayer().name;
  }

  _deselectLayer(layerId) {
    for (const s of this.project.sketches) {
      for (const e of s.entities) {
        if (e.layerId !== layerId) continue;
        e.selected = false; e.hover = false;
        for (const c of e.children()) { c.selected = false; c.hover = false; }
      }
    }
  }

  /** Top-level entities whose style the panel edits. Selecting only a
   *  line end or a centre leaves the panel on the drawing style, since a
   *  shared corner belongs to several entities. */
  _styleTargets() {
    const out = [];
    for (const s of this.project.sketches) for (const e of s.entities) if (e.selected) out.push(e);
    return out;
  }

  /* ---- Style panel ---- */
  _swatchesHtml(key, value, allowNone) {
    return `
      <div class="swatches" data-key="${key}">
        ${allowNone ? `<button class="sw sw-none${value === null ? ' on' : ''}" data-v="none" title="No fill">${uiIcon('none')}</button>` : ''}
        ${PALETTE.map(c => `<button class="sw${value === c ? ' on' : ''}" data-v="${c}" style="--sw:${c}" title="${c}"></button>`).join('')}
        <label class="sw sw-custom${value && !PALETTE.includes(value) ? ' on' : ''}" title="Custom colour" style="--sw:${value || '#888888'}">
          <input type="color" value="${value || '#888888'}" data-key="${key}">
        </label>
      </div>`;
  }

  _refreshStylePanel() {
    const body = document.getElementById('style-body');
    if (!body) return;
    const project = this.project;
    const targets = this._styleTargets();
    const onSelection = targets.length > 0;
    document.getElementById('style-title').textContent = onSelection ? 'Selection style' : 'Drawing style';
    document.getElementById('style-target').textContent = onSelection
      ? `${targets.length} entit${targets.length === 1 ? 'y' : 'ies'}`
      : 'next shapes';

    // Current values; undefined when the selection is mixed.
    const common = (fn) => {
      const vals = new Set(targets.map(fn));
      return vals.size === 1 ? [...vals][0] : undefined;
    };
    const st = (e) => resolveStyle(e, project.layerOf(e));
    const cur = onSelection ? {
      color: common(e => st(e).color),
      lineWidth: common(e => st(e).lineWidth),
      lineStyle: common(e => st(e).lineStyle),
      fill: common(e => st(e).fill),
      fillOpacity: common(e => st(e).fillOpacity),
      layerId: common(e => e.layerId),
    } : {
      color: this.pen.color, lineWidth: this.pen.lineWidth, lineStyle: this.pen.lineStyle,
      fill: this.pen.fillColor, fillOpacity: this.pen.fillOpacity,
    };

    const mixed = (v) => v === undefined ? '<option value="" selected>Mixed</option>' : '';
    const weightOpts = LINE_WEIGHTS.map(w => `<option value="${w}"${cur.lineWidth === w ? ' selected' : ''}>${w} px</option>`).join('');
    const typeOpts = Object.entries(LINE_STYLES).map(([k, v]) => `<option value="${k}"${cur.lineStyle === k ? ' selected' : ''}>${v.label}</option>`).join('');

    let html = '';
    if (onSelection) {
      html += `<div class="prop-row"><label>layer</label>
        <select data-key="layerId">${mixed(cur.layerId)}${[...project.layers].reverse().map(l => `<option value="${l.id}"${cur.layerId === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`;
    }
    html += `<div class="sb-subhead">Stroke</div>${this._swatchesHtml('color', cur.color, false)}`;
    html += `<div class="prop-row"><label>weight</label><select data-key="lineWidth">${mixed(cur.lineWidth)}${weightOpts}</select></div>`;
    html += `<div class="prop-row"><label>line type</label><select data-key="lineStyle">${mixed(cur.lineStyle)}${typeOpts}</select></div>`;
    html += `<div class="sb-subhead">Fill</div>${this._swatchesHtml('fill', cur.fill === undefined ? undefined : (cur.fill || null), onSelection)}`;
    const fo = cur.fillOpacity ?? 0.35;
    html += `<div class="prop-row"><label>fill opacity</label>
      <div class="range-row"><input type="range" min="0.05" max="1" step="0.05" value="${fo}" data-key="fillOpacity"><span>${Math.round(fo * 100)}%</span></div></div>`;
    if (!onSelection) {
      html += `<label class="check-row"><input type="checkbox" data-key="fillShapes"${this.pen.fillShapes ? ' checked' : ''}> Fill new closed shapes</label>`;
      html += `<div class="empty">Applies to the next shapes you draw. The Fill tool (B) paints regions with the fill colour.${this.colorMode === 'status' ? ' Stroke colours are hidden while <b>Status</b> colouring is on.' : ''}</div>`;
    }
    body.innerHTML = html;

    const live = (key, value) => this._applyStyle(targets, onSelection, key, value, false);
    const commit = (key, value) => this._applyStyle(targets, onSelection, key, value, true);

    body.querySelectorAll('.swatches button.sw').forEach(b => b.addEventListener('click', () => {
      commit(b.closest('.swatches').dataset.key, b.dataset.v === 'none' ? 'none' : b.dataset.v);
    }));
    body.querySelectorAll('.swatches input[type=color]').forEach(inp => {
      inp.addEventListener('input', () => live(inp.dataset.key, inp.value));
      inp.addEventListener('change', () => commit(inp.dataset.key, inp.value));
    });
    body.querySelectorAll('select[data-key]').forEach(sel => sel.addEventListener('change', () => {
      if (sel.value === '') return;
      const k = sel.dataset.key;
      commit(k, k === 'lineWidth' ? parseFloat(sel.value) : sel.value);
    }));
    body.querySelectorAll('input[type=range]').forEach(r => {
      const label = r.nextElementSibling;
      const read = () => { label.textContent = Math.round(r.value * 100) + '%'; return parseFloat(r.value); };
      r.addEventListener('input', () => live(r.dataset.key, read()));
      r.addEventListener('change', () => commit(r.dataset.key, read()));
    });
    const cb = body.querySelector('input[type=checkbox][data-key="fillShapes"]');
    if (cb) cb.addEventListener('change', () => commit('fillShapes', cb.checked));
  }

  /** Writes one style key: to the selected entities (with an undo step),
   *  or to the drawing style (a preference, no undo step). `final`
   *  rebuilds the panel. */
  _applyStyle(targets, onSelection, key, value, final) {
    if (onSelection) {
      for (const e of targets) {
        if (key === 'layerId') { e.layerId = value; continue; }
        const next = { ...(e.style || {}) };
        next[key] = value;
        e.style = cleanStyle(next);
      }
      if (final) {
        if (key === 'layerId') this.clearSelection();   // moved off the active layer
        this._layerChanged();
      } else this.requestRender();
      return;
    }
    const penKey = key === 'fill' ? 'fillColor' : key;
    this.pen[penKey] = value;
    this._penChanged(final);
    if (final) { this._refreshStylePanel(); this.refreshToolOptions(); }
  }

  /* ---- Fill tool options (left panel) ---- */
  _refreshFillOptions(section, body) {
    section.hidden = false;
    document.getElementById('tool-options-title').textContent = 'Fill';
    body.innerHTML = `
      <div class="choice-grid">
        <button class="choice-row ${this.fillErase ? '' : 'active'}" data-mode="fill">
          <span class="sw-dot" style="--sw:${this.pen.fillColor}"></span><span>Fill</span></button>
        <button class="choice-row ${this.fillErase ? 'active' : ''}" data-mode="erase">${uiIcon('x')}<span>Erase fill</span></button>
      </div>
      <div class="empty">${this.fillErase
        ? 'Click a filled region on this layer to remove its fill. Click outside every region to clear the background.'
        : 'Click inside a closed region to fill it. Inner shapes stay as holes. Click outside every region to fill the background. Change the colour in Drawing style → Fill.'}</div>`;
    body.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      this.fillErase = b.dataset.mode === 'erase';
      this.refreshToolOptions();
      document.getElementById('status-hint').textContent = (this.tool.hint && this.tool.hint()) || '';
    }));
  }
}

import { cleanStyle } from '../core/style.js';
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

   Also owns per-browser preferences: theme, colour mode, dimension
   visibility and the drawing style (pen) used for new shapes.
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
    this.setDimensionsVisible(prefs.showDimensions !== false, false);
    this.showDimNames = !!prefs.showDimNames;
  }
  _savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: this.themeName, colorMode: this.colorMode, pen: this.pen, showDimensions: this.showDimensions, showDimNames: !!this.showDimNames }));
    } catch { /* storage unavailable */ }
  }
  setTheme(name, save = true) {
    this.themeName = name === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = this.themeName;
    this.renderer.theme = getTheme(this.themeName);
    const b = document.querySelector('#menubar [data-action="theme"]');
    if (b) b.innerHTML = uiIcon(this.themeName === 'dark' ? 'sun' : 'moon').replace('class="ui-icon"', '');
    if (save) this._savePrefs();
    this.requestRender();
  }
  setColorMode(mode, save = true) {
    this.colorMode = mode === 'status' ? 'status' : 'style';
    this.renderer.colorMode = this.colorMode;
    const b = document.querySelector('#menubar [data-action="color-mode"]');
    if (b) b.classList.toggle('on', this.colorMode === 'status');
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
      row.className = 'lyr-row' + (layer.id === project.activeLayerId ? ' active' : '') + (layer.visible ? '' : ' hidden-layer') + (layer.locked ? ' locked' : '');
      row.dataset.layerId = layer.id;
      row.innerHTML = `
        <button class="icon-btn" data-k="vis" title="${layer.visible ? 'Hide' : 'Show'} layer" aria-label="Toggle visibility">${uiIcon(layer.visible ? 'eye' : 'eyeOff')}</button>
        <button class="icon-btn${layer.locked ? ' on' : ''}" data-k="lock" title="${layer.locked ? 'Unlock' : 'Lock'} layer (locked geometry never moves)" aria-label="Toggle lock">${uiIcon(layer.locked ? 'lock' : 'unlock')}</button>
        <span class="name" title="Double-click to rename">${esc(layer.name)}${layer.locked ? '<span class="lock-tag">Locked</span>' : ''}</span>
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
    const active = project.activeLayer();
    const status = document.getElementById('status-layer');
    if (status) {
      status.textContent = 'Layer: ' + active.name + (active.locked ? ' — locked' : '');
      status.classList.toggle('locked', active.locked);
    }
    this._refreshLockBanner();
  }

  /** Banner over the canvas while the active layer is locked. */
  _refreshLockBanner() {
    const banner = document.getElementById('lock-banner');
    if (!banner) return;
    const layer = this.project.activeLayer();
    banner.hidden = !layer.locked;
    if (!layer.locked) return;
    banner.innerHTML = `${uiIcon('lock')}<span>Layer <b>${esc(layer.name)}</b> is locked: its geometry can't move or be edited.</span>
      <button class="unlock">${uiIcon('unlock')}Unlock</button>`;
    banner.querySelector('.unlock').addEventListener('click', () => {
      layer.locked = false;
      this._layerChanged();
    });
  }
  _flashLockBanner() {
    this._refreshLockBanner();
    const banner = document.getElementById('lock-banner');
    banner.classList.remove('flash');
    void banner.offsetWidth;            // restart the animation
    banner.classList.add('flash');
    document.getElementById('status-hint').textContent = 'The active layer is locked. Unlock it or pick another layer to draw.';
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
}

import { cleanStyle } from '../core/style.js';
import { getTheme } from '../render/theme.js';
import { uiIcon } from '../ui/icons.js';

const PREFS_KEY = 'onsketch:prefs';
const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Drawing style used by the tools: line weight and line type for new
 *  geometry, and the colour the Fill tool paints with. Stroke colour is
 *  never chosen: it always shows the geometry's state. */
const DEFAULT_PEN = { lineWidth: 1.4, lineStyle: 'solid', fillColor: '#1f7ad6', fillOpacity: 0.35 };

/* =============== LAYERS + STYLE PANELS =========================
   Right-hand sidebar. "Layers" lists project layers top-most first
   (as in most image editors): visibility, lock, opacity, order. Layers carry no
   colours of their own.

   Also owns per-browser preferences: theme, dimension visibility, the
   drawing style (line weight / type, fill colour).
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
    const saved = prefs.pen || {};
    this.pen = { ...DEFAULT_PEN };
    for (const k of Object.keys(DEFAULT_PEN)) if (saved[k] !== undefined) this.pen[k] = saved[k];
    this.fillErase = false;
    this._penChanged(false);
    this.setTheme(prefs.theme || (systemDark ? 'dark' : 'light'), false);
    this.setDimensionsVisible(prefs.showDimensions !== false, false);
    this.showDimNames = !!prefs.showDimNames;
  }
  _savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: this.themeName, pen: this.pen, showDimensions: this.showDimensions, showDimNames: !!this.showDimNames }));
    } catch { /* storage unavailable */ }
  }
  setTheme(name, save = true) {
    this.themeName = name === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = this.themeName;
    this.renderer.theme = getTheme(this.themeName);
    const b = document.querySelector('#menubar [data-action="theme"]');
    if (b) b.innerHTML = uiIcon(this.themeName === 'dark' ? 'sun' : 'moon');
    if (save) this._savePrefs();
    this.requestRender();
  }


  /** Entity style handed to new geometry. */
  _penStyle() {
    return cleanStyle({ lineWidth: this.pen.lineWidth, lineStyle: this.pen.lineStyle });
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
      const isActive = layer.id === project.activeLayerId;
      row.className = 'lyr-row' + (isActive ? ' active' : '') + (layer.visible ? '' : ' hidden-layer');
      row.title = isActive ? 'Active layer: the only one you can edit' : 'Click to edit this layer';
      row.dataset.layerId = layer.id;
      row.innerHTML = `
        <button class="icon-btn" data-k="vis" title="${layer.visible ? 'Hide' : 'Show'} layer" aria-label="Toggle visibility">${uiIcon(layer.visible ? 'eye' : 'eyeOff')}</button>
        <span class="name" title="Double-click to rename">${esc(layer.name)}</span>
        <span class="count">${counts.get(layer.id) || 0}</span>`;
      row.querySelector('[data-k="vis"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        layer.visible = !layer.visible;
        if (!layer.visible) this._deselectLayer(layer.id);
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
        project.syncLocks();            // the other layers are now held still
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
      status.textContent = 'Layer: ' + active.name;
    }
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

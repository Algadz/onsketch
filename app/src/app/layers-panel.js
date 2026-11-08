import { cleanStyle } from '../core/style.js';
import { getTheme } from '../render/theme.js';
import { uiIcon } from '../ui/icons.js';
import { track } from './analytics.js';
import { INK_DEFAULTS } from './sketch-window.js';

const PREFS_KEY = 'onsketch:prefs';
const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Drawing style used by the tools: line weight and line type for new
 *  geometry, and the colour the Fill tool paints with. Stroke colour is
 *  never chosen: it always shows the geometry's state. */
const DEFAULT_PEN = { lineWidth: 1.4, lineStyle: 'solid', fillColor: '#1f7ad6', fillOpacity: 0.35, ...INK_DEFAULTS };

/* =============== LAYERS + STYLE PANELS =========================
   Right-hand sidebar. "Layers" lists project layers top-most first
   (as in Paint.NET): visibility, lock, opacity, order. Layers carry no
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
      track('layer-add', { layers: this.project.layers.length });
      this.clearSelection();
      this._layerChanged();
    });
    btn('layer-up', 'up', () => { if (this.project.moveLayer(this.project.activeLayerId, +1)) this._layerChanged(); });
    btn('layer-down', 'down', () => { if (this.project.moveLayer(this.project.activeLayerId, -1)) this._layerChanged(); });
    btn('layer-delete', 'trash', () => {
      const layer = this.project.activeLayer();
      if (this.project.layers.length <= 1) return alert('A project needs at least one layer.');
      const n = this.project.entitiesOnLayer(layer.id).length
        + this.project.sketches.reduce((k, s) => k + s.strokes.filter(st => st.layerId === layer.id).length, 0);
      if (!confirm(n ? `Delete layer "${layer.name}" and its ${n} item${n === 1 ? '' : 's'}?` : `Delete layer "${layer.name}"?`)) return;
      this.project.removeLayer(layer.id);
      track('layer-delete');
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
    this.setRelationsVisible(prefs.showRelations !== false, false);
  }
  _savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: this.themeName, pen: this.pen, showDimensions: this.showDimensions, showDimNames: !!this.showDimNames, showRelations: this.showRelations !== false }));
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
    for (const s of project.sketches) for (const st of s.strokes) counts.set(st.layerId, (counts.get(st.layerId) || 0) + 1);
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



  /** Move the selected shapes to another layer. Their own relations and
   *  dimensions (those that only involve them) go with them; corners they
   *  share with shapes left behind are split on commit (each layer keeps
   *  its own point, joined by a coincident). */
  moveSelectionToLayer(layerId) {
    const sketch = this.activeSketch();
    if (!sketch || !this.project.layer(layerId) || layerId === this.project.activeLayerId) return;
    const moving = sketch.entities.filter(e => e.selected);
    if (!moving.length) return;
    const ids = new Set();
    for (const e of moving) { ids.add(e.id); for (const c of e.children()) ids.add(c.id); }
    // Points still used by shapes that stay are not "only theirs".
    for (const e of sketch.entities) if (!e.selected) for (const c of e.children()) ids.delete(c.id);
    const movedEntities = new Set(moving.map(e => e.id));
    const names = (c) => [c.lineId, c.circleId, c.c1, c.c2, c.ref?.arcId, c.ref1?.arcId, c.ref2?.arcId].filter(Boolean);
    const own = (c) => names(c).some(id => movedEntities.has(id))           // e.g. the line's horizontal
      || c.refs().filter(Boolean).every(id => ids.has(id));
    for (const c of sketch.constraints) if (own(c)) c.layerId = layerId;
    for (const e of moving) e.layerId = layerId;
    this.clearSelection();
    this.commit();
    this.refreshUI();
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

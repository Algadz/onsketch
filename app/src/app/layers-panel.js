import { LINE_STYLES, LINE_WEIGHTS, PALETTE, cleanStyle, resolveStyle } from '../core/style.js';
import { getTheme } from '../render/theme.js';
import { uiIcon } from '../ui/icons.js';

const PREFS_KEY = 'onsketch:prefs';
const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =============== LAYERS + STYLE PANELS =========================
   Right-hand sidebar. "Layers" lists project layers top-most first
   (as in Paint.NET). "Style" edits the selected entities' overrides,
   or the active layer's defaults when nothing is selected.
   Also owns the view preferences: theme and colour mode.
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
      this.commit();
      this.refreshUI();
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
    this.setTheme(prefs.theme || (systemDark ? 'dark' : 'light'), false);
    this.setColorMode(prefs.colorMode || 'status', false);
  }
  _savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: this.themeName, colorMode: this.colorMode })); } catch { /* storage unavailable */ }
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
    this.colorMode = mode === 'layer' ? 'layer' : 'status';
    this.renderer.colorMode = this.colorMode;
    const b = document.querySelector('#topbar [data-action="color-mode"]');
    if (b) b.classList.toggle('on', this.colorMode === 'layer');
    const label = document.getElementById('color-mode-label');
    if (label) label.textContent = this.colorMode === 'layer' ? 'Layer' : 'Status';
    if (save) this._savePrefs();
    this.requestRender();
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
        <button class="icon-btn${layer.locked ? ' on' : ''}" data-k="lock" title="${layer.locked ? 'Unlock' : 'Lock'} layer" aria-label="Toggle lock">${uiIcon(layer.locked ? 'lock' : 'unlock')}</button>
        <label class="lyr-swatch" title="Layer colour" style="--sw:${layer.color}">
          <input type="color" value="${layer.color}" aria-label="Layer colour">
          ${layer.fill ? `<span class="lyr-fill" style="--fl:${layer.fill}"></span>` : ''}
        </label>
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
      const color = row.querySelector('input[type=color]');
      color.addEventListener('click', (ev) => ev.stopPropagation());
      color.addEventListener('input', () => { layer.color = color.value; row.querySelector('.lyr-swatch').style.setProperty('--sw', color.value); this.requestRender(); });
      color.addEventListener('change', () => { layer.color = color.value; this._layerChanged(); });
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
   *  line end or a centre leaves the panel on the layer, since a shared
   *  corner belongs to several entities. */
  _styleTargets() {
    const out = [];
    for (const s of this.project.sketches) for (const e of s.entities) if (e.selected) out.push(e);
    return out;
  }

  /* ---- Style panel ---- */
  _refreshStylePanel() {
    const body = document.getElementById('style-body');
    if (!body) return;
    const project = this.project;
    const targets = this._styleTargets();
    const layer = project.activeLayer();
    const onSelection = targets.length > 0;
    document.getElementById('style-title').textContent = onSelection ? 'Selection style' : 'Layer style';
    document.getElementById('style-target').textContent = onSelection
      ? `${targets.length} entit${targets.length === 1 ? 'y' : 'ies'}`
      : layer.name;

    // Shared value of a key across the targets (undefined when mixed).
    const common = (fn) => {
      const vals = new Set(targets.map(fn));
      return vals.size === 1 ? [...vals][0] : undefined;
    };
    let cur;
    if (onSelection) {
      cur = {
        color: common(e => resolveStyle(e, project.layerOf(e)).color),
        lineWidth: common(e => resolveStyle(e, project.layerOf(e)).lineWidth),
        lineStyle: common(e => resolveStyle(e, project.layerOf(e)).lineStyle),
        fill: common(e => resolveStyle(e, project.layerOf(e)).fill),
        fillOpacity: common(e => resolveStyle(e, project.layerOf(e)).fillOpacity),
        layerId: common(e => e.layerId),
        override: (k) => targets.some(e => e.style && e.style[k] !== undefined),
      };
    } else {
      cur = { ...layer, override: () => false };
    }

    const swatches = (key, value, allowNone) => `
      <div class="swatches" data-key="${key}">
        ${allowNone ? `<button class="sw sw-none${value === null ? ' on' : ''}" data-v="none" title="No fill">${uiIcon('none')}</button>` : ''}
        ${PALETTE.map(c => `<button class="sw${value === c ? ' on' : ''}" data-v="${c}" style="--sw:${c}" title="${c}"></button>`).join('')}
        <label class="sw sw-custom${value && !PALETTE.includes(value) ? ' on' : ''}" title="Custom colour" style="--sw:${value || '#888888'}">
          <input type="color" value="${value || '#888888'}" data-key="${key}">
        </label>
      </div>`;
    const byLayer = (key) => onSelection && cur.override(key)
      ? `<button class="link-btn" data-reset="${key}" title="Use the layer's value">by layer</button>` : '';
    const weightOpts = LINE_WEIGHTS.map(w => `<option value="${w}"${cur.lineWidth === w ? ' selected' : ''}>${w} px</option>`).join('');
    const typeOpts = Object.entries(LINE_STYLES).map(([k, v]) => `<option value="${k}"${cur.lineStyle === k ? ' selected' : ''}>${v.label}</option>`).join('');
    const mixed = (v) => v === undefined ? '<option value="" selected>Mixed</option>' : '';

    let html = '';
    if (!onSelection) {
      html += `<div class="prop-row"><label>opacity</label>
        <div class="range-row"><input type="range" min="0" max="1" step="0.05" value="${layer.opacity}" data-layer="opacity"><span>${Math.round(layer.opacity * 100)}%</span></div></div>`;
    } else {
      html += `<div class="prop-row"><label>layer</label>
        <select data-key="layerId">${mixed(cur.layerId)}${[...project.layers].reverse().map(l => `<option value="${l.id}"${cur.layerId === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`;
    }
    html += `<div class="sb-subhead">Stroke ${byLayer('color')}</div>${swatches('color', cur.color, false)}`;
    html += `<div class="prop-row"><label>weight ${byLayer('lineWidth')}</label><select data-key="lineWidth">${mixed(cur.lineWidth)}${weightOpts}</select></div>`;
    html += `<div class="prop-row"><label>line type ${byLayer('lineStyle')}</label><select data-key="lineStyle">${mixed(cur.lineStyle)}${typeOpts}</select></div>`;
    html += `<div class="sb-subhead">Fill ${byLayer('fill')}</div>${swatches('fill', cur.fill === undefined ? undefined : (cur.fill || null), true)}`;
    const fo = cur.fillOpacity ?? 0.25;
    html += `<div class="prop-row"><label>fill opacity</label>
      <div class="range-row"><input type="range" min="0.05" max="1" step="0.05" value="${fo}" data-key="fillOpacity"><span>${Math.round(fo * 100)}%</span></div></div>`;
    html += `<div class="empty">Fills apply to circles and closed loops of lines and arcs; nested profiles become holes.${this.colorMode === 'status' ? ' Stroke colours show when <b>Colors: Layer</b> is on.' : ''}</div>`;
    body.innerHTML = html;

    const live = (key, value) => this._applyStyle(targets, onSelection, key, value, false);
    const commit = (key, value) => this._applyStyle(targets, onSelection, key, value, true);

    body.querySelectorAll('.swatches button.sw').forEach(b => b.addEventListener('click', () => {
      const key = b.closest('.swatches').dataset.key;
      commit(key, b.dataset.v === 'none' ? 'none' : b.dataset.v);
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
      if (r.dataset.layer) {
        r.addEventListener('input', () => { layer.opacity = read(); this.requestRender(); });
        r.addEventListener('change', () => { layer.opacity = read(); this._layerChanged(); });
      } else {
        r.addEventListener('input', () => live(r.dataset.key, read()));
        r.addEventListener('change', () => commit(r.dataset.key, read()));
      }
    });
    body.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () => commit(b.dataset.reset, undefined)));
  }

  /** Writes one style key. On a selection it becomes a per-entity
   *  override (undefined clears it); otherwise it changes the active
   *  layer's default. `final` commits an undo step and rebuilds the UI. */
  _applyStyle(targets, onSelection, key, value, final) {
    if (onSelection) {
      for (const e of targets) {
        if (key === 'layerId') { e.layerId = value; continue; }
        const next = { ...(e.style || {}) };
        if (value === undefined) delete next[key]; else next[key] = value;
        e.style = cleanStyle(next);
      }
    } else {
      const layer = this.project.activeLayer();
      if (key === 'fill') layer.fill = value === 'none' ? null : value;
      else if (value !== undefined) layer[key] = value;
    }
    if (final) this._layerChanged();
    else this.requestRender();
  }
}

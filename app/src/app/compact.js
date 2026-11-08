import { ACTION_ICONS, DRAW_TOOLS, TOOLS, TOOL_ICONS, WINDOW_ICONS, toolDef } from '../ui/tool-defs.js';

/* =============== PHONE LAYOUT ("compact") ======================
   On a touch screen that is narrow (< 700 px) or short (< 500 px, a phone
   on its side), the chrome changes; the canvas and tools don't:
   - top bar: logo, Undo, Redo, project name, and ⋯ for everything else
     (file, view toggles, theme, stylus mode, report);
   - bottom bar in the thumb zone: Select, Draw ▸, Dimension, Paint ▸,
     Panels ▸ (Layers, Colors, Properties, Equations);
   - windows open as bottom sheets, one at a time, swipe down to close;
   - the options bar becomes a row of chips above the bottom bar;
   - the status shows as a pill on the canvas.
   Mouse / desktop screens never match the media query, so the desktop
   layout is unchanged; all compact styles live under `.compact`.
   ============================================================ */
// Also used by the inline start-up script in app/index.html: keep both in step.
const COMPACT_QUERY = '(pointer: coarse) and (max-width: 699px), (pointer: coarse) and (max-height: 499px)';
const PAINT_TOOLS = ['fill', 'pen', 'marker', 'eraser'];
const PANELS = [['layers', 'Layers'], ['colors', 'Colours'], ['props', 'Properties'], ['equations', 'Equations']];

export class CompactMixin {
  _setupCompact() {
    this._compactMQ = window.matchMedia(COMPACT_QUERY);
    const land = window.matchMedia('(orientation: landscape)');
    const apply = () => {
      this.setCompact(this._compactMQ.matches);
      document.documentElement.classList.toggle('compact-land', this._compactMQ.matches && land.matches);
      if (this.compact) requestAnimationFrame(() => { this.renderer.resize(); this.requestRender(); });
    };
    this._compactMQ.addEventListener?.('change', apply);
    land.addEventListener?.('change', apply);
    this._lastTool = { draw: 'line', paint: 'pen' };
    document.getElementById('more-btn')?.addEventListener('click', (e) => { e.stopPropagation(); this._toggleMoreMenu(); });
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#more-menu, #more-btn')) this._toggleMoreMenu(false);
      if (!e.target.closest('#mb-flyout, #mobilebar')) this._closeFlyout();
    });
    apply();
  }

  setCompact(on) {
    on = !!on;
    if (this.compact === on && document.documentElement.classList.contains('compact') === on) return;
    this.compact = on;
    document.documentElement.classList.toggle('compact', on);
    this.windows.setCompact(on);
    if (on) this._renderMobileBar();
    else { this._closeFlyout(); this._toggleMoreMenu(false); }
    requestAnimationFrame(() => { this.renderer.resize(); this.requestRender(); });
  }

  /* ---- Bottom bar ---- */
  _renderMobileBar() {
    const bar = document.getElementById('mobilebar');
    if (!bar || !this.compact) return;
    const t = this.toolName;
    const group = DRAW_TOOLS.has(t) ? 'draw' : PAINT_TOOLS.includes(t) ? 'paint' : t;
    if (group === 'draw' || group === 'paint') this._lastTool[group] = t;
    const panelOpen = PANELS.some(([id]) => this.windows.isOpen(id));
    const slot = (id, icon, label, active, more = false) =>
      `<button type="button" class="mb-slot${active ? ' on' : ''}" data-slot="${id}" aria-label="${label}"${more ? ' aria-haspopup="true"' : ''}>${icon}<span>${label}${more ? ' ▴' : ''}</span></button>`;
    bar.innerHTML =
      slot('select', TOOL_ICONS.select, 'Select', t === 'select') +
      slot('draw', TOOL_ICONS[this._lastTool.draw], 'Draw', group === 'draw', true) +
      slot('smartdim', TOOL_ICONS.smartdim, 'Dimension', t === 'smartdim') +
      slot('paint', TOOL_ICONS[this._lastTool.paint], 'Paint', group === 'paint', true) +
      slot('panels', WINDOW_ICONS.layers, 'Panels', panelOpen, true);
    bar.querySelectorAll('[data-slot]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.slot;
      if (id === 'select' || id === 'smartdim') { this._closeFlyout(); this.setTool(id); }
      else this._openFlyout(id, b);
    }));
  }

  _openFlyout(kind, anchor) {
    const fly = document.getElementById('mb-flyout');
    if (!fly) return;
    if (!fly.hidden && fly.dataset.kind === kind) { this._closeFlyout(); return; }
    let items = [];
    if (kind === 'draw') items = TOOLS.filter(x => x.group === 'sketch').map(x => ({ id: x.id, icon: TOOL_ICONS[x.id], label: x.label, on: this.toolName === x.id }));
    if (kind === 'paint') {
      items = PAINT_TOOLS.map(id => ({ id, icon: TOOL_ICONS[id], label: toolDef(id).label, on: this.toolName === id }));
      items.push({ id: 'panel:colors', icon: WINDOW_ICONS.colors, label: 'Colours', on: this.windows.isOpen('colors') });
    }
    if (kind === 'panels') items = PANELS.map(([id, label]) => ({ id: 'panel:' + id, icon: WINDOW_ICONS[id], label, on: this.windows.isOpen(id) }));
    fly.dataset.kind = kind;
    fly.innerHTML = items.map(i => `<button type="button" class="fly-item${i.on ? ' on' : ''}" data-id="${i.id}">${i.icon}<span>${i.label}</span></button>`).join('');
    fly.hidden = false;
    const r = anchor.getBoundingClientRect(), fr = fly.getBoundingClientRect();
    if (document.documentElement.classList.contains('compact-land')) {
      fly.style.left = Math.max(8, r.left - fr.width - 8) + 'px';
      fly.style.top = Math.max(8, Math.min(window.innerHeight - fr.height - 8, r.top + r.height / 2 - fr.height / 2)) + 'px';
      fly.style.bottom = 'auto';
    } else {
      fly.style.left = Math.max(8, Math.min(window.innerWidth - fr.width - 8, r.left + r.width / 2 - fr.width / 2)) + 'px';
      fly.style.top = 'auto';
      fly.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    }
    fly.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id;
      this._closeFlyout();
      if (id.startsWith('panel:')) this.windows.toggle(id.slice(6));
      else this.setTool(id);
      this._renderMobileBar();
    }));
  }
  _closeFlyout() { const f = document.getElementById('mb-flyout'); if (f) f.hidden = true; }

  /* ---- ⋯ menu ---- */
  _moreItems() {
    const check = (on) => `<span class="chk">${on ? '✓' : ''}</span>`;
    return [
      ['new', 'New sketch'], ...(this.cloudEnabled ? [['open', 'Open…']] : []), ['save', 'Save'], ['solve', 'Re-solve'],
      '-',
      ['grid', 'Grid', this.gridOn], ['snap', 'Snap', this.snapOn], ['dimensions', 'Dimensions', this.showDimensions],
      ['relations', 'Relations', this.showRelations], ['zoom-fit', 'Zoom to fit'], ['theme', 'Dark theme', this.themeName === 'dark'],
      '-',
      ...(!this.cloudEnabled ? [] : this.cloudUser
        ? ['-', ['my-sketches', 'My sketches'], ['library', 'Library'], ['profile', 'Public profile'], ['signout', 'Sign out']]
        : ['-', ['account', 'Sign in'], ['library', 'Library']]),
      ['stylus', 'Only the pencil draws', !!this.stylusMode],
      ['report', 'Report a problem'],
    ].map(x => x === '-' ? '<div class="more-sep"></div>'
      : `<button type="button" class="more-item" data-more="${x[0]}">${ACTION_ICONS[x[0]] || ''}<span>${x[1]}</span>${x.length > 2 ? check(x[2]) : ''}</button>`).join('');
  }
  _refreshMoreMenu() {
    const m = document.getElementById('more-menu');
    if (!m || m.hidden) return;
    m.innerHTML = this._moreItems();
    m.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () => this._runMore(b.dataset.more)));
  }
  _toggleMoreMenu(open) {
    const m = document.getElementById('more-menu');
    if (!m) return;
    const show = open ?? m.hidden;
    m.hidden = !show;
    if (show) this._refreshMoreMenu();
  }
  _runMore(a) {
    this._toggleMoreMenu(false);
    if (a === 'stylus') { this.setStylusMode(!this.stylusMode); return; }
    if (a === 'report') { document.getElementById('report-open')?.click(); return; }
    const btn = document.querySelector(`#menubar [data-action="${a}"]`);
    this._runAction(a, btn);
  }
}

export { COMPACT_QUERY };

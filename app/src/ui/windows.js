/* =============== FLOATING WINDOWS ==============================
   Paint.NET-style tool windows floating over the canvas. Drag by the
   title bar, close with ×, reopen from the menu bar. Position and
   open state are remembered per browser.
   ============================================================ */
const STORE_KEY = 'onsketch:windows';
const MARGIN = 8;

export class WindowManager {
  /**
   * @param {HTMLElement} container  positioned parent (the workspace)
   * @param {Object} defaults  id → (containerW, containerH, winW, winH) => {x, y}
   * @param {Function} onChange  called after a window opens or closes
   */
  constructor(container, defaults, onChange = () => {}) {
    this.container = container;
    this.defaults = defaults;
    this.onChange = onChange;
    this.wins = new Map();
    this.z = 10;
    // Phone layout (compact.js): windows become bottom sheets, one open at a
    // time, not saved, so the desktop layout is untouched.
    this.compact = false;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { saved = {}; }
    this.state = saved;
    for (const el of container.querySelectorAll('.fwin[data-win]')) this._register(el);
    window.addEventListener('resize', () => this.layout());
  }

  _register(el) {
    const id = el.dataset.win;
    this.wins.set(id, el);
    const st = this.state[id] || (this.state[id] = { open: !el.hasAttribute('data-closed') });
    el.hidden = !st.open;
    el.querySelector('.fwin-x')?.addEventListener('click', () => this.toggle(id, false));
    el.addEventListener('pointerdown', () => { el.style.zIndex = ++this.z; });
    const head = el.querySelector('.fwin-head');
    // A finger on the title bar is our drag / swipe, never a browser gesture.
    // touch-action: none stops the scroll, but a quick flick still starts an
    // (invisible) fling in Chromium, and the next tap anywhere — e.g. ⋯
    // right after swiping a sheet closed — only stops that fling and never
    // clicks. Cancelling touchstart keeps the browser out of it entirely.
    head.addEventListener('touchstart', (ev) => {
      if (!ev.target.closest('button, input, select')) ev.preventDefault();
    }, { passive: false });
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button, input, select')) return;
      ev.preventDefault();
      if (this.compact) {                          // sheet: swipe down to close
        const y0 = ev.clientY;
        head.setPointerCapture(ev.pointerId);
        const up = (e) => {
          head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up);
          if (e.clientY - y0 > 40) this.toggle(id, false);
        };
        head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
        return;
      }
      const start = { x: ev.clientX, y: ev.clientY, left: el.offsetLeft, top: el.offsetTop };
      head.setPointerCapture(ev.pointerId);
      el.classList.add('dragging');
      const move = (e) => this._place(id, start.left + e.clientX - start.x, start.top + e.clientY - start.y);
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        this._save();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  _place(id, x, y) {
    if (this.compact) return;
    const el = this.wins.get(id);
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    x = Math.max(MARGIN, Math.min(x, cw - w - MARGIN));
    y = Math.max(MARGIN, Math.min(y, Math.max(MARGIN, ch - Math.min(h, 40) - MARGIN)));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    Object.assign(this.state[id], { x, y });
  }

  /** Position every open window: saved spot (clamped) or its default. */
  layout() {
    if (this.compact) return;
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    for (const [id, el] of this.wins) {
      if (el.hidden) continue;
      const st = this.state[id];
      if (Number.isFinite(st.x) && Number.isFinite(st.y)) this._place(id, st.x, st.y);
      else {
        const d = this.defaults[id](cw, ch, el.offsetWidth, el.offsetHeight);
        this._place(id, d.x, d.y);
        delete st.x; delete st.y;      // keep following the default until moved
      }
    }
  }

  isOpen(id) { return !this.wins.get(id)?.hidden; }

  toggle(id, open = !this.isOpen(id)) {
    const el = this.wins.get(id);
    if (!el) return;
    if (this.compact) {
      if (open) for (const [other, w] of this.wins) if (other !== id) w.hidden = true;
      el.hidden = !open;
      this.onChange();
      return;
    }
    el.hidden = !open;
    this.state[id].open = open;
    if (open) { el.style.zIndex = ++this.z; this.layout(); }
    this._save();
    this.onChange();
  }

  /** Enter / leave the phone layout. Leaving restores the saved layout. */
  setCompact(on) {
    on = !!on;
    if (on === this.compact) return;
    this.compact = on;
    for (const [id, el] of this.wins) {
      el.hidden = on ? true : !this.state[id].open;
      if (on) { el.style.left = ''; el.style.top = ''; }
    }
    if (!on) this.layout();
    this.onChange();
  }

  reset() {
    if (this.compact) { for (const el of this.wins.values()) el.hidden = true; this.onChange(); return; }
    for (const [id, el] of this.wins) {
      this.state[id] = { open: !el.hasAttribute('data-closed') };
      el.hidden = !this.state[id].open;
    }
    this.layout();
    this._save();
    this.onChange();
  }

  _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch { /* storage unavailable */ }
  }
}

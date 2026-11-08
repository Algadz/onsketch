import { Arc, Circle, Line, Point } from '../core/entities.js';
import { allDimensions } from '../core/equations.js';
import { DRAW_TOOLS, toolDef } from '../ui/tool-defs.js';

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =============== TOUCH CONTROLS ================================
   Only shown once touch or a stylus has been used (`touchUI`, set in
   touch.js), so the desktop options bar is unchanged:
   - Select: a multi-select toggle (instead of Ctrl / Shift), Delete, and
     nudge arrows that move the selection by a round step;
   - drawing tools: Done (what Escape / double-click do with a keyboard);
   - the dimension keypad: digits, units, operators and the names of
     dimensions and variables, instead of the phone keyboard.
   ============================================================ */
export class TouchUIMixin {
  _touchOptionsHTML(t) {
    if (!this.touchUI) return '';
    const sep = '<span class="opt-sep"></span>';
    let html = '';
    const hasSel = this.selectedEntitiesAndPoints().length || this.selectedStrokes().length;
    if (t.id === 'select') {
      html += sep + `<button class="tbtn toggle${this.multiSelect ? ' on' : ''}" data-touch="multi" title="Add to selection: taps add or remove instead of replacing">＋<span class="btn-label">Multi-select</span></button>`;
      if (hasSel) {
        html += `<button class="tbtn" data-touch="delete" title="Delete the selection">✕<span class="btn-label">Delete</span></button>`;
        html += sep + `<span class="nudge" aria-label="Nudge selection by ${this._nudgeStep()} ${esc(this.project.units)}">`
          + ['←', '↑', '↓', '→'].map((g, i) => `<button class="tbtn" data-nudge="${i}" title="Nudge ${['left', 'up', 'down', 'right'][i]}">${g}</button>`).join('')
          + `<span class="opt-val">${this._nudgeStep()} ${esc(this.project.units)}</span></span>`;
      }
    } else if (DRAW_TOOLS.has(t.id) || ['smartdim', 'pen', 'marker', 'eraser', 'fill'].includes(t.id)) {
      html += sep + `<button class="tbtn" data-touch="done" title="Finish (like Escape)">✓<span class="btn-label">Done</span></button>`;
    }
    return html;
  }

  _bindTouchOptions(bar) {
    bar.querySelectorAll('[data-touch]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.touch;
      if (k === 'multi') { this.multiSelect = !this.multiSelect; this._refreshOptionsBar(); }
      else if (k === 'delete') this.deleteSelection();
      else if (k === 'done') {
        const before = this.toolName, hadChain = !!this.tool.startPt;
        this.tool.onKey && this.tool.onKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
        if (!hadChain && this.toolName === before && before !== 'select') this.setTool('select');
      }
    }));
    bar.querySelectorAll('[data-nudge]').forEach(b => b.addEventListener('click', () => {
      const s = this._nudgeStep();
      const [dx, dy] = [[-s, 0], [0, s], [0, -s], [s, 0]][+b.dataset.nudge];
      this.nudgeSelection(dx, dy);
    }));
  }

  /** A round step of about 12 screen pixels: 1, 2 or 5 × 10ⁿ. */
  _nudgeStep() {
    const raw = 12 / this.view.zoom;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
    return Number(step.toPrecision(3));
  }

  /** Move the selected shapes (through the solver, as a drag would) and
   *  the selected ink by (dx, dy). One undo step. */
  nudgeSelection(dx, dy) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const pts = [], seen = new Set(), rigidLines = [];
    let first = null;
    for (const e of sketch.entities) {
      const walk = (x, inherit) => {
        const sel = inherit || x.selected;
        if (sel && !first) first = x;
        if (x instanceof Point && sel && !x.fixed && !x.locked && !seen.has(x)) { seen.add(x); pts.push({ p: x, x: x.x, y: x.y }); }
        for (const c of x.children()) walk(c, sel);
      };
      walk(e, e.selected);
      if (e instanceof Line && e.selected) rigidLines.push({ lineId: e.id, p1: e.p1.id, p2: e.p2.id, dx: e.p2.x - e.p1.x, dy: e.p2.y - e.p1.y });
    }
    let moved = false;
    if (pts.length) {
      const start = { x: pts[0].x, y: pts[0].y };
      const drag = this.beginLocalizedDrag(start, pts, first, rigidLines);
      if (drag) { this.solveLocalizedDrag(drag, dx, dy); moved = true; }
    }
    for (const s of this.selectedStrokes()) { s.points = s.points.map(p => ({ x: p.x + dx, y: p.y + dy })); moved = true; }
    if (moved) { this.commit(); this.refreshUI(); this.requestRender(); }
  }

  /* ---- Dimension keypad ---- */
  _openKeypad(input, vi, submitKey) {
    this._closeKeypad();
    input.setAttribute('inputmode', 'none');        // no phone keyboard: the keypad types
    const names = [...allDimensions(this.project).filter(c => c.name && c.name !== vi.selfName).map(c => c.name),
      ...(this.project.variables || []).map(v => v.name)];
    const pad = document.createElement('div');
    pad.id = 'dimpad';
    pad.setAttribute('role', 'group');
    pad.setAttribute('aria-label', 'Dimension keypad');
    const key = (k, label = k, cls = '') => `<button type="button" class="${cls}" data-k="${esc(k)}">${esc(label)}</button>`;
    pad.innerHTML = `
      <div class="pad-names">${names.length ? names.map(n => key(n, n, 'name')).join('') : '<span class="pad-hint">Tap a shape to use its size</span>'}</div>
      <div class="pad-units">${['mm', 'cm', 'm', 'in', 'ft', 'deg'].map(u => key(u, u === 'deg' ? '°' : u, 'unit')).join('')}</div>
      <div class="pad-keys">
        ${key('7')}${key('8')}${key('9')}${key('/', '÷', 'op')}${key('back', '⌫', 'op')}
        ${key('4')}${key('5')}${key('6')}${key('*', '×', 'op')}${key('(', '(', 'op')}
        ${key('1')}${key('2')}${key('3')}${key('-', '−', 'op')}${key(')', ')', 'op')}
        ${key('0')}${key('.')}${key('=', '=', 'op')}${key('+', '+', 'op')}${key('enter', '↵', 'go')}
      </div>
      <div class="pad-foot">${key('kbd', '⌨ Keyboard', 'small')}${key('clear', 'Clear', 'small')}${key('cancel', 'Cancel', 'small')}</div>`;
    pad.addEventListener('pointerdown', (e) => { e.preventDefault(); vi.hold(); });
    pad.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      const k = b.dataset.k;
      const v = input.value, a = input.selectionStart ?? v.length, z = input.selectionEnd ?? v.length;
      const put = (text, caret) => { input.value = text; const c = caret ?? text.length; input.setSelectionRange(c, c); input.dispatchEvent(new Event('input')); };
      if (k === 'enter') submitKey('Enter');
      else if (k === 'cancel') submitKey('Escape');
      else if (k === 'kbd') { input.setAttribute('inputmode', 'text'); this._closeKeypad(); input.blur(); setTimeout(() => input.focus(), 0); return; }
      else if (k === 'clear') put('');
      else if (k === 'back') put(a !== z ? v.slice(0, a) + v.slice(z) : v.slice(0, Math.max(0, a - 1)) + v.slice(a), a !== z ? a : Math.max(0, a - 1));
      else if (b.classList.contains('name')) { vi.insert(k); return; }
      else { const t = (b.classList.contains('unit') ? k : k); put(v.slice(0, a) + t + v.slice(z), a + t.length); }
      vi.hold();
    });
    document.body.appendChild(pad);
    document.documentElement.classList.add('keypad-open');
  }
  _closeKeypad() {
    document.getElementById('dimpad')?.remove();
    document.documentElement.classList.remove('keypad-open');
  }

  /** Keep a value box above the on-screen keyboard. */
  _keepAboveKeyboard(input) {
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const fit = () => {
      const r = input.getBoundingClientRect();
      const limit = vv.height + vv.offsetTop - 12;
      if (r.bottom > limit) {
        const ws = document.getElementById('workspace').getBoundingClientRect();
        input.style.top = (limit - ws.top - r.height / 2) + 'px';
      }
    };
    vv.addEventListener('resize', fit);
    return () => vv.removeEventListener('resize', fit);
  }

  /* used by tests and the compact shell */
  _toolGroupOf(id) {
    if (DRAW_TOOLS.has(id)) return 'draw';
    if (['fill', 'pen', 'marker', 'eraser'].includes(id)) return 'paint';
    return id;
  }
  _toolLabel(id) { return toolDef(id).label; }
  _isShape(e) { return e instanceof Line || e instanceof Circle || e instanceof Arc; }
}

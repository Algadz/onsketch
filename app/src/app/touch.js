import { Project } from '../core/model.js';

/* =============== TOUCH AND STYLUS INPUT ========================
   Mouse input never comes through here (render-events.js sends mouse
   events straight to the tools), so the desktop behaves exactly as
   before. For touch and pen:

   - One finger is held back until it moves (then it is a drag, replayed
     into the tool from where it started), lifts (a tap: down + up), or
     stays still for 450 ms (a long press: the context menu).
   - A second finger turns it into a gesture: pan + pinch-zoom around the
     two fingers. If the tool had already started (a drag), that action is
     undone first. Two-finger tap = Undo, three-finger tap = Redo.
   - Double tap on empty canvas with Select = zoom to fit.
   - Stylus mode (on once a pen is seen, can be turned off): the pen draws,
     fingers only pan and zoom, which also ignores a resting palm.
   - Hit tolerances grow for fingers (2.5×) and a little for pens (1.5×).
   - A loupe magnifies the canvas above the finger while placing or
     dragging points.
   ============================================================ */
const LONG_PRESS_MS = 450;
const SLOP_PX = 8;
const TAP_MS = 300;

export class TouchMixin {
  /** Every pointer event: remember the input kind for hit tolerances. */
  _noteInput(ev) {
    const type = ev.pointerType || 'mouse';
    if (type === this._inputType) return;
    this._inputType = type;
    const scale = type === 'touch' ? 2.5 : type === 'pen' ? 1.5 : 1;
    this._inputScale = scale;
    this.snap.tolPx = 10 * scale;
    this.renderer.badgeSize = type === 'mouse' ? null : 19;
    if (type !== 'mouse' && !this.touchUI) {
      this.touchUI = true;                         // touch-only chrome (Delete, Done, keypad…)
      document.documentElement.classList.add('touch-ui');
      this._refreshOptionsBar();
    }
    if (type === 'pen' && this.stylusMode == null) this.setStylusMode(true, false);
  }

  /** View used for hit tests: the real one for the mouse; for touch a
   *  copy with the zoom divided, so every "within N px" test is N × scale. */
  _hitView() {
    const s = this._inputScale || 1;
    if (s === 1) return this.view;
    const v = this.view;
    return { zoom: v.zoom / s, worldToScreen: (p) => v.worldToScreen(p), screenToWorld: (p) => v.screenToWorld(p) };
  }
  /** Extra screen padding around labels and badges for touch. */
  _hitPad() { return ((this._inputScale || 1) - 1) * 8; }

  setStylusMode(on, save = true) {
    this.stylusMode = !!on;
    document.documentElement.classList.toggle('stylus-mode', this.stylusMode);
    if (save) try { localStorage.setItem('onsketch:stylus', this.stylusMode ? '1' : '0'); } catch { /* storage unavailable */ }
    if (this._refreshMoreMenu) this._refreshMoreMenu();
  }
  _loadStylusPref() {
    try { const v = localStorage.getItem('onsketch:stylus'); if (v != null) this.stylusMode = v === '1'; } catch { /* storage unavailable */ }
  }

  /* ---- The filter in front of the canvas handlers ---- */

  /** @returns {boolean} true when the event was consumed here */
  _touchFilter(kind, ev) {
    const T = (this._touch ||= { ptrs: new Map(), pending: null, active: null, gesture: null, lastTap: null });
    const h = this._canvasHandlers;
    const pos = { x: ev.clientX, y: ev.clientY };

    if (ev.pointerType === 'pen') {                 // precise: straight to the tool
      if (kind === 'down') this.hideContextMenu();
      if (kind === 'cancel') { h.up(ev); return true; }
      if (kind === 'move' && !(ev.buttons & 1) && !T.penDown) return false;
      if (kind === 'down') { T.penDown = true; this._loupeStart(ev); }
      if (kind === 'up') { T.penDown = false; this._loupeStop(); }
      return false;
    }

    // ---- touch ----
    if (kind === 'down') {
      T.ptrs.set(ev.pointerId, { start: pos, pos, t0: performance.now() });
      try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
      const n = T.ptrs.size;
      if (n === 1 && !this.stylusMode) {
        this.hideContextMenu();
        T.pending = { ev, id: ev.pointerId, start: pos, t0: performance.now(), timer: setTimeout(() => this._longPress(), LONG_PRESS_MS) };
        return true;
      }
      // Second finger (or any finger in stylus mode): gesture.
      if (T.pending) { clearTimeout(T.pending.timer); T.pending = null; }
      if (T.active) { this._abortToolAction(); T.active = null; this._loupeStop(); }
      this._gestureStart(T);
      return true;
    }

    const p = T.ptrs.get(ev.pointerId);
    if (!p) return true;                          // a finger we never tracked
    p.pos = pos;

    if (kind === 'move') {
      if (T.gesture) { this._gestureMove(T); return true; }
      if (T.pending && T.pending.id === ev.pointerId) {
        if (Math.hypot(pos.x - T.pending.start.x, pos.y - T.pending.start.y) < SLOP_PX) return true;
        clearTimeout(T.pending.timer);
        const first = T.pending.ev;
        T.pending = null;
        T.active = ev.pointerId;
        h.down(first);                            // the drag starts where the finger landed
        this._loupeStart(first);
        h.move(ev);
        return true;
      }
      if (T.active === ev.pointerId) { h.move(ev); return true; }
      return true;
    }

    // up / cancel
    T.ptrs.delete(ev.pointerId);
    if (T.gesture) {
      T.gesture.maxFingers = Math.max(T.gesture.maxFingers, T.ptrs.size + 1);
      if (T.ptrs.size === 0) this._gestureEnd(T);
      return true;
    }
    if (T.pending && T.pending.id === ev.pointerId) {
      clearTimeout(T.pending.timer);
      const first = T.pending.ev, longPressed = T.pending.longPressed;
      T.pending = null;
      if (longPressed || kind === 'cancel') return true;
      // A tap: down + up where the finger landed (double tap on empty
      // canvas with Select zooms to fit).
      const now = performance.now();
      const last = T.lastTap;
      T.lastTap = { t: now, x: pos.x, y: pos.y };
      if (this.toolName === 'select' && last && now - last.t < TAP_MS && Math.hypot(pos.x - last.x, pos.y - last.y) < 24
          && !this.hitTestActiveSketch(h.getWorld(first).world)) {
        T.lastTap = null;
        this.zoomFit();
        return true;
      }
      h.down(first);
      h.up(ev);
      return true;
    }
    if (T.active === ev.pointerId) {
      T.active = null;
      this._loupeStop();
      h.up(ev);
      return true;
    }
    return true;
  }

  _longPress() {
    const T = this._touch; const pend = T && T.pending;
    if (!pend || T.ptrs.size !== 1) return;
    pend.longPressed = true;
    const { screen, world } = this._canvasHandlers.getWorld(pend.ev);
    if (this._valueInput) return;                 // a value box is open: nothing to show
    const c = this.hitRelationAtScreen(screen.x, screen.y) || this.hitDimAtScreen(screen.x, screen.y);
    if (c && this.showConstraintMenu(c, pend.start.x, pend.start.y)) { try { navigator.vibrate?.(12); } catch { /* not supported */ } return; }
    if (this.showContextMenu(screen, world, { clientX: pend.start.x, clientY: pend.start.y })) {
      try { navigator.vibrate?.(12); } catch { /* not supported */ }
    }
  }

  /** A second finger arrived after a drag started: put things back. */
  _abortToolAction() {
    const t = this.tool;
    const changed = t && (t.dragging || (t.inkDrag && t.inkDrag.moved) || (t.erasing && t.removed));
    if (changed && this.undoStack.length) {
      this.project = Project.fromJSON(JSON.parse(this.undoStack[this.undoStack.length - 1]));
      this._afterStateSwap();
    }
    this.lastDragSnaps = [];
    this.setTool(this.toolName);                  // fresh tool state, same tool
  }

  /* ---- Pan and pinch ---- */
  _fingers(T) {
    const pts = [...T.ptrs.values()].map(p => p.pos);
    const r = this.canvas.getBoundingClientRect();
    if (!pts.length) return null;
    const a = pts[0], b = pts[1] || pts[0];
    return { c: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, d: Math.hypot(b.x - a.x, b.y - a.y), n: pts.length };
  }
  _gestureStart(T) {
    const f = this._fingers(T);
    T.gesture = { f0: f, zoom0: this.view.zoom, world0: this.view.screenToWorld(f.c), t0: performance.now(), moved: false, maxFingers: f.n };
    this.lastSnap = null;
    document.getElementById('cursor-hint').style.display = 'none';
  }
  _gestureMove(T) {
    const g = T.gesture, f = this._fingers(T);
    if (!f) return;
    if (f.n !== g.f0.n) { this._gestureStart(T); T.gesture.maxFingers = Math.max(g.maxFingers, f.n); T.gesture.moved = g.moved; return; }
    if (Math.hypot(f.c.x - g.f0.c.x, f.c.y - g.f0.c.y) > 10 || Math.abs(f.d - g.f0.d) > 10) g.moved = true;
    const v = this.view;
    if (f.n >= 2 && g.f0.d > 10) v.zoom = Math.min(5000, Math.max(0.05, g.zoom0 * f.d / g.f0.d));
    // keep the world point that was under the fingers under them
    v.panX = f.c.x - v.cssW / 2 - g.world0.x * v.zoom;
    v.panY = f.c.y - v.cssH / 2 + g.world0.y * v.zoom;
    document.getElementById('status-zoom').textContent = 'Zoom: ' + Math.round(v.zoom * 25) + '%';
    this.requestRender();
  }
  _gestureEnd(T) {
    const g = T.gesture;
    T.gesture = null;
    if (!g.moved && performance.now() - g.t0 < TAP_MS + 100) {
      if (g.maxFingers === 2) this.undo();
      else if (g.maxFingers >= 3) this.redo();
    }
  }

  /* ---- Loupe ---- */
  _loupeWanted() {
    const n = this.toolName;
    return ['line', 'centerLine', 'rectangle', 'centerRectangle', 'circle', 'threePointCircle', 'arc', 'hexagon', 'point', 'smartdim'].includes(n)
      || (n === 'select' && !!this.tool?.dragging);
  }
  _loupeStart(ev) { this._loupeOn = true; this._loupeFollow(ev); }
  _loupeStop() {
    this._loupeOn = false; this._loupeAt = null;
    const el = document.getElementById('loupe'); if (el) el.hidden = true;
  }
  _loupeFollow(ev, screen) {
    if (!this._loupeOn || (ev.pointerType !== 'touch' && ev.pointerType !== 'pen')) return;
    if (!screen) screen = this._canvasHandlers.getWorld(ev).screen;
    this._loupeAt = screen;
    this.requestRender();
  }
  /** Called after each render: copy the area under the finger, 2×. */
  _drawLoupe() {
    const el = document.getElementById('loupe');
    if (!el) return;
    if (!this._loupeOn || !this._loupeAt || !this._loupeWanted()) { el.hidden = true; return; }
    const D = 116, Z = 2, dpr = this.renderer.dpr || 1;
    if (el.width !== D * dpr) { el.width = D * dpr; el.height = D * dpr; el.style.width = D + 'px'; el.style.height = D + 'px'; }
    const { x, y } = this._loupeAt;
    const ctx = el.getContext('2d');
    const src = D / Z;
    ctx.save();
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(this.canvas, (x - src / 2) * dpr, (y - src / 2) * dpr, src * dpr, src * dpr, 0, 0, el.width, el.height);
    ctx.strokeStyle = this.renderer.theme.selected; ctx.lineWidth = 1.2 * dpr;
    const m = el.width / 2;
    ctx.beginPath(); ctx.moveTo(m - 8 * dpr, m); ctx.lineTo(m + 8 * dpr, m); ctx.moveTo(m, m - 8 * dpr); ctx.lineTo(m, m + 8 * dpr); ctx.stroke();
    ctx.restore();
    const h = this.canvas.clientHeight;
    const top = y - D - 46 < 0 ? Math.min(h - D, y + 46) : y - D - 46;
    el.style.left = Math.max(0, Math.min(this.canvas.clientWidth - D, x - D / 2)) + 'px';
    el.style.top = top + 'px';
    el.hidden = false;
  }
}

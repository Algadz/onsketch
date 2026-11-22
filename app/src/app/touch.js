import { zoomText } from './render-events.js';
import { track } from '../ui/analytics.js';

/* =============== TOUCH AND STYLUS INPUT ========================
   Mouse input never comes through here (render-events.js sends mouse
   events straight to the tools), so the desktop behaves exactly as
   before. For touch and pen:

   - One finger is held back until it moves (then it is a drag, replayed
     into the tool from where it started), lifts (a tap: down + up), or
     stays still for 450 ms (a long press: the context menu; moving the
     finger after that drags nothing).
   - A second finger turns it into a gesture: pan + pinch-zoom around the
     two fingers. If the tool had already started (a drag), that action is
     undone first. A two-finger tap does nothing (it fired by mistake on
     quick pinches: Undo is in the top bar); three-finger tap = Redo.
   - Double tap on empty canvas with Select = zoom to fit.
   - Stylus mode (on once a pen is seen, can be turned off): the pen draws,
     fingers only pan and zoom, which also ignores a resting palm.
   - Hit tolerances grow for fingers (2.5×) and a little for pens (1.5×).
   - A loupe magnifies the canvas under the finger while placing or
     dragging points. It sits still in a top corner, the one away from
     the finger (switching sides only past 40 % / 60 % of the width), so
     it never hides where the finger is heading and doesn't chase it.
     It waits 150 ms (or a move) before showing, so taps don't flash it.
   - Two-point tools (line, rectangle, circle…): every point is placed
     the same way. Touch, and a crosshair (with the snap and the
     magnifier) shows where it would go; slide to aim; lift to place. A
     quick tap places it where you tap. The point waiting for its partner
     pulses, and once it is there the next touch shows the line or shape
     from it at once, so it is always clear which point comes next. The
     status pill says the step: ① start, ② end (or "next point"). Lines
     chain: each end starts the next segment; tap the pulsing point, the
     ✓ Done chip beside it, or Done in the bar to stop.
   ============================================================ */
const TWO_POINT = { line: 'startPt', centerLine: 'center', rectangle: 'start', centerRectangle: 'center', circle: 'center', hexagon: 'center' };
const TWO_POINT_MOVE_PX = 10;
const FIRST = { line: 'start point', centerLine: 'midpoint', rectangle: 'first corner', centerRectangle: 'center', circle: 'center', hexagon: 'center' };
const SECOND = { line: 'end point', centerLine: 'one end', rectangle: 'opposite corner', centerRectangle: 'a corner', circle: 'a point on the circle', hexagon: 'a corner' };
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const PEN_SEEN_KEY = 'onsketch:pen-seen';     // '1' once a pen touched the canvas on this device
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
      track('touch-used', { input: type, layout: this.compact ? 'phone' : 'large' });
      document.documentElement.classList.add('touch-ui');
      this._refreshOptionsBar();
    }
    if (type === 'pen' && !this.penSeen) {
      // First pen on this device: remember it, then use the choice made
      // here before (if any), else turn stylus mode on.
      this.penSeen = true;
      try { localStorage.setItem(PEN_SEEN_KEY, '1'); } catch { /* storage unavailable */ }
      const saved = this._storedStylus();
      this.setStylusMode(saved ?? true, false);
    }
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
  _storedStylus() {
    try { const v = localStorage.getItem('onsketch:stylus'); return v == null ? null : v === '1'; } catch { return null; }
  }
  /** Stylus mode only exists on a device where a pen was used: a choice
   *  saved without one (a tap in the menu on a phone) is ignored, so
   *  fingers always draw on a phone and the menu item stays hidden. */
  _loadStylusPref() {
    try { this.penSeen = localStorage.getItem(PEN_SEEN_KEY) === '1'; } catch { this.penSeen = false; }
    this.stylusMode = null;
    if (this.penSeen) { const v = this._storedStylus(); if (v != null) this.stylusMode = v; }
    document.documentElement.classList.toggle('stylus-mode', !!this.stylusMode);
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
        this._twoPointFeedback(ev);               // show the aim / the line from the pending point at once
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
        if (T.pending.menu) return true;          // a long press opened a menu: the finger is choosing, not dragging
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
    this._clearTwoPointFeedback();
    const { screen, world } = this._canvasHandlers.getWorld(pend.ev);
    if (this._valueInput) return;                 // a value box is open: nothing to show
    const c = this.hitDimAtScreen(screen.x, screen.y) || this.hitRelationAtScreen(screen.x, screen.y);
    if (c && this.showConstraintMenu(c, pend.start.x, pend.start.y)) { pend.menu = true; try { navigator.vibrate?.(12); } catch { /* not supported */ } return; }
    if (this.showContextMenu(screen, world, { clientX: pend.start.x, clientY: pend.start.y })) {
      pend.menu = true;
      try { navigator.vibrate?.(12); } catch { /* not supported */ }
    }
  }

  /* ---- Two-point tools on touch and pen ---- */

  /** The first point of a two-point tool, once placed (else null). */
  _twoPointAnchor() {
    const k = TWO_POINT[this.toolName];
    return k ? this.tool[k] || null : null;
  }

  /** Touch / pen down with a two-point tool: start aiming the point
   *  (nothing is placed until the finger lifts). @returns {boolean} handled */
  _twoPointDown(world, snap, screen, ev) {
    this._twoPt = null;
    if (!(this.toolName in TWO_POINT)) return false;
    const armed = !!this._twoPointAnchor();
    this._twoPt = { armed, start: screen };
    this._twoPointAim(world, snap, ev);
    return true;
  }

  /** While aiming (finger down): the crosshair, or the line / shape from
   *  the pending point. */
  _twoPointAim(world, snap, ev) {
    if (this._twoPointAnchor()) { this._touchAim = null; this.tool.onPointerMove(world, snap, ev); }
    else { this._touchAim = snap && !snap.rejected ? { x: snap.x, y: snap.y } : { ...world }; this.tool.cursor = null; }
    this.requestRender();
  }

  /** Finger moved with a two-point tool (from render-events' move). */
  _twoPointMove(world, snap, ev) {
    if (!this._twoPt || !(this.toolName in TWO_POINT)) return;
    this._twoPointAim(world, snap, ev);
  }

  /** Touch / pen up with a two-point tool: the point goes where the
   *  finger lifts. @returns {boolean} handled */
  _twoPointUp(world, snap, screen, ev) {
    const g = this._twoPt;
    this._twoPt = null;
    this._touchAim = null;
    if (!g || !(this.toolName in TWO_POINT)) return false;
    if (ev.type === 'pointercancel') { this._abortTwoPoint(g); return true; }
    const moved = Math.hypot(screen.x - g.start.x, screen.y - g.start.y) > TWO_POINT_MOVE_PX;
    this.tool.onPointerDown(world, snap, ev);
    // Tapping the pending point again ends the line chain.
    if (g.armed && this.toolName === 'line' && this.tool.invalidEnd && !moved) this.tool.terminateChain(false);
    this.tool.cursor = null;                       // no stale preview: touch has no hover
    this._refreshTouchStep();
    this.requestRender();
    return true;
  }

  /** Undo what the current two-point touch did (second finger, cancel):
   *  nothing was placed yet, only the aim goes. */
  _abortTwoPoint() {
    this._touchAim = null;
    if (this.tool) this.tool.cursor = null;
    this.requestRender();
  }

  /** Feedback as soon as a finger lands (before it moves or lifts). */
  _twoPointFeedback(ev) {
    if (!(this.toolName in TWO_POINT) || !this._canvasHandlers) return;
    const { world } = this._canvasHandlers.getWorld(ev);
    const snap = this._snapForCurrentTool ? this._snapForCurrentTool(world) : null;
    this.lastSnap = snap;
    this._twoPointAim(world, snap, ev);
  }
  _clearTwoPointFeedback() {
    if (!(this.toolName in TWO_POINT)) return;
    this._touchAim = null; this.lastSnap = null;
    if (this.tool) this.tool.cursor = null;
    this.requestRender();
  }

  /* ---- Saying which point comes next (touch) ---- */

  /** The status text of a two-point tool on touch: which step. */
  _touchStepText() {
    const name = this.toolName, how = 'touch, slide to aim, lift to place';
    if (!this._twoPointAnchor()) return `① ${cap(FIRST[name])}: ${how}.`;
    if (name === 'line') {
      return this.tool._lastPlaced ? `Next point: ${how}. Tap ● or ✓ Done to stop.` : `② End point: ${how}. Tap ● again to cancel.`;
    }
    return `② ${cap(SECOND[name])}: ${how}.`;
  }
  /** Two-point tools say their step on touch (wraps the tool's hint). */
  _wrapTouchHint() {
    if (!(this.toolName in TWO_POINT) || !this.tool?.hint) return;
    const own = this.tool.hint.bind(this.tool);
    this.tool.hint = () => (this.touchUI ? this._touchStepText() : own());
  }
  _refreshTouchStep() {
    if (!this.touchUI || !(this.toolName in TWO_POINT)) return;
    const el = document.getElementById('status-hint');
    if (el && !(this.toolName === 'line' && this.tool.invalidEnd)) el.textContent = this._touchStepText();
  }

  /** Drawn every frame: the aim crosshair, the pulsing pending point and
   *  the ✓ Done chip of a line chain (touch). */
  _drawTwoPointTouch() {
    const chip = document.getElementById('chain-done');
    const anchor = this.touchUI && this.toolName in TWO_POINT ? this._twoPointAnchor() : null;
    const ctx = this.renderer.ctx, v = this.view;
    if (this._touchAim && this.touchUI) {
      const s = v.worldToScreen(this._touchAim);
      ctx.save();
      ctx.strokeStyle = this.renderer.theme.preview || '#1f7ad6'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.x - 20, s.y); ctx.lineTo(s.x - 6, s.y); ctx.moveTo(s.x + 6, s.y); ctx.lineTo(s.x + 20, s.y);
      ctx.moveTo(s.x, s.y - 20); ctx.lineTo(s.x, s.y - 6); ctx.moveTo(s.x, s.y + 6); ctx.lineTo(s.x, s.y + 20); ctx.stroke();
      ctx.restore();
    }
    if (anchor) {
      const s = v.worldToScreen(anchor), t = (performance.now() % 1200) / 1200;
      ctx.save();
      ctx.fillStyle = this.renderer.theme.preview || '#1f7ad6';
      ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.55 * (1 - t); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.x, s.y, 7 + 14 * t, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      // keep pulsing, gently (not every frame)
      clearTimeout(this._pulseTimer);
      this._pulseTimer = setTimeout(() => this.requestRender(), 60);
    }
    // ✓ Done beside the pending point of a line chain
    const chaining = anchor && this.toolName === 'line' && this.tool._lastPlaced;
    if (!chaining) { if (chip) chip.hidden = true; return; }
    let c = chip;
    if (!c) {
      c = document.createElement('button');
      c.type = 'button'; c.id = 'chain-done'; c.className = 'chain-done';
      c.textContent = '✓ Done'; c.title = 'Stop the line here';
      c.addEventListener('pointerdown', (e) => e.stopPropagation());
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.toolName === 'line' && this.tool.startPt) this.tool.terminateChain(false);
        this._refreshTouchStep(); this.requestRender();
      });
      (this.canvas.parentElement || document.body).appendChild(c);
    }
    c.hidden = false;
    const r = this.canvas.getBoundingClientRect(), pr = c.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
    const s = v.worldToScreen(anchor), w = c.offsetWidth || 70, h = c.offsetHeight || 30;
    const x = Math.min(Math.max(8, s.x + 16), r.width - w - 8), y = Math.min(Math.max(8, s.y - h - 14), r.height - h - 8);
    c.style.left = (r.left - pr.left + x) + 'px';
    c.style.top = (r.top - pr.top + y) + 'px';
  }

  /** A second finger arrived after a drag started: put things back. */
  _abortToolAction() {
    if (this._twoPt) {                            // nothing committed yet by a two-point touch
      const g = this._twoPt; this._twoPt = null;
      this.lastDragSnaps = [];
      this._abortTwoPoint(g);
      return;
    }
    const t = this.tool;
    const changed = t && (t.dragging || (t.inkDrag && t.inkDrag.moved) || (t.erasing && t.removed));
    if (changed && this.undoStack.length) {
      this._swapSameDocument(this.undoStack[this.undoStack.length - 1]);
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
    document.getElementById('status-zoom').textContent = zoomText(v.zoom);
    this.requestRender();
  }
  _gestureEnd(T) {
    const g = T.gesture;
    T.gesture = null;
    if (!g.moved && performance.now() - g.t0 < TAP_MS + 100) {
      if (g.maxFingers >= 3) this.redo();
    }
  }

  /* ---- Loupe ---- */
  _loupeWanted() {
    const n = this.toolName;
    return ['line', 'centerLine', 'rectangle', 'centerRectangle', 'circle', 'threePointCircle', 'arc', 'hexagon', 'point', 'curve', 'smartdim'].includes(n)
      || (n === 'select' && !!this.tool?.dragging);
  }
  _loupeStart(ev) {
    this._loupeOn = true; this._loupeSide = null;
    this._loupeShowAt = performance.now() + 150;
    clearTimeout(this._loupeTimer);
    this._loupeTimer = setTimeout(() => this.requestRender(), 160);
    this._loupeDown = null;
    this._loupeFollow(ev);
  }
  _loupeStop() {
    this._loupeOn = false; this._loupeAt = null;
    clearTimeout(this._loupeTimer);
    const el = document.getElementById('loupe'); if (el) el.hidden = true;
  }
  _loupeFollow(ev, screen) {
    if (!this._loupeOn || (ev.pointerType !== 'touch' && ev.pointerType !== 'pen')) return;
    if (!screen) screen = this._canvasHandlers.getWorld(ev).screen;
    if (!this._loupeDown) this._loupeDown = screen;
    else if (Math.hypot(screen.x - this._loupeDown.x, screen.y - this._loupeDown.y) > SLOP_PX) this._loupeShowAt = 0;
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
    // A top corner, away from the finger; flips only well past the middle.
    const w = this.canvas.clientWidth;
    if (!this._loupeSide) this._loupeSide = x < w / 2 ? 'right' : 'left';
    else if (this._loupeSide === 'right' && x > w * 0.6) this._loupeSide = 'left';
    else if (this._loupeSide === 'left' && x < w * 0.4) this._loupeSide = 'right';
    const pad = 10, top = this.compact ? 52 : pad;      // below the status chips on a phone
    el.style.left = (this._loupeSide === 'left' ? pad : w - D - pad) + 'px';
    el.style.top = top + 'px';
    el.hidden = performance.now() < (this._loupeShowAt || 0);
  }
}
